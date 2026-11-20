// SPDX-License-Identifier: MIT
// Explicit offline authoring commands; never loaded by the application.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const L = require('./stage-authoring-lib.cjs');

function options(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    L.ensure(/^--[a-z-]+$/.test(argv[i]) && argv[i + 1] && !Object.hasOwn(values, argv[i]), 'expected unique --option value pairs');
    values[argv[i]] = path.resolve(argv[i + 1]);
  }
  return values;
}
function requireOptions(opts, keys) {
  L.ensure(Object.keys(opts).every(key => keys.includes(key)) && keys.every(key => opts[key]), 'required options: ' + keys.join(', '));
}
function newDirectory(dir) { fs.mkdirSync(path.dirname(dir), { recursive: true }); fs.mkdirSync(dir); }
function snapshotSources(scratch, lock) {
  const target = path.join(scratch, 'source'); fs.mkdirSync(target);
  let totalBytes = 0;
  for (const file of L.SOURCE_FILES) {
    const bytes = fs.readFileSync(path.join(L.ROOT, file));
    totalBytes += bytes.length; L.ensure(totalBytes <= L.LIMITS.sourceBytes, 'fixed source snapshot exceeds byte limit');
    L.ensure(L.sha(bytes) === lock.sourceSha256[file], 'source changed during snapshot: ' + file);
    const destination = path.join(target, file); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
  }
  return target;
}
function pendingReview(bundleHash, candidateHash) {
  return { reviewVersion: 1, bundleHash, candidateHash,
    gates: Object.fromEntries(L.REVIEW_GATES.map(gate => [gate,
      { status: 'pending', reviewer: '', reviewedAt: '', evidence: '', notes: '' }])) };
}
async function build(inputPath, lockPath, out) {
  const input = L.readJson(inputPath), lock = L.readJson(lockPath, L.LIMITS.outputBytes);
  L.verifyLock(lock);
  newDirectory(out);
  const scratch = fs.mkdtempSync(path.join(out, '.scratch-'));
  const startedAt = new Date().toISOString();
  try {
    const sourceRoot = snapshotSources(scratch, lock);
    const prepared = await L.runWorker(path.join(sourceRoot, 'scripts/stage-authoring-prepare.cjs'), { input, sourceRoot },
      { cwd: scratch, permissionRead: sourceRoot, heapMiB: L.LIMITS.prepareHeapMiB, timeoutMs: L.LIMITS.prepareMs });
    const rendered = await L.runWorker(path.join(sourceRoot, 'scripts/stage-authoring-render.cjs'), {
      sourceRoot, scratch, preset: prepared.value.prepared.preset,
      playwrightPath: lock.toolchain.playwright.path, browserPath: lock.toolchain.browser.path },
    { cwd: scratch, heapMiB: L.LIMITS.renderHeapMiB, timeoutMs: L.LIMITS.renderMs, protoGuard: false });
    L.ensure(rendered.value.passed && rendered.value.browserClosed && rendered.value.contextClosed, 'renderer did not complete cleanup');
    // Toolchain/source drift after execution invalidates the bundle as well.
    L.verifyLock(lock);
    const candidate = { ...prepared.value, lockHash: L.digest(lock),
      sourceSha256: lock.sourceSha256, candidateStatus: 'pending-human-review' };
    L.writeJson(path.join(out, 'candidate.json'), candidate);
    L.writeJson(path.join(out, 'toolchain-lock.json'), lock);
    fs.writeFileSync(path.join(out, 'share-code.txt'), candidate.prepared.shareCode + '\n', { flag: 'wx' });
    const render = rendered.value, imageFiles = [];
    for (const profile of render.profiles) for (const image of profile.images) {
      L.ensure(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image.png), 'invalid renderer image');
      const name = profile.profile.name + '-' + image.label + '.png';
      fs.writeFileSync(path.join(out, name), Buffer.from(image.png.split(',')[1], 'base64'), { flag: 'wx' });
      delete image.png; image.file = name; imageFiles.push(name);
    }
    render.elapsedMs = rendered.elapsedMs; L.writeJson(path.join(out, 'render-report.json'), render);
    const files = ['candidate.json', 'toolchain-lock.json', 'share-code.txt', 'render-report.json', ...imageFiles];
    const bundle = { bundleVersion: 1, startedAt, finishedAt: new Date().toISOString(),
      candidateHash: candidate.prepared.proposalHash, lockHash: L.digest(lock),
      files: Object.fromEntries(files.map(file => [file, L.fileHash(path.join(out, file))])),
      mechanical: { prepare: candidate.validation, renderer: render.passed, prepareMs: prepared.elapsedMs,
        renderMs: rendered.elapsedMs, resourcesReleased: render.profiles.every(item => item.resources.released) },
      admission: 'blocked-pending-human-device-isolation-and-owner-review',
      releaseGates: L.REVIEW_GATES, isolationQualification: 'not-established',
      limits: L.LIMITS };
    bundle.bundleHash = L.digest(bundle); L.writeJson(path.join(out, 'bundle.json'), bundle);
    L.writeJson(path.join(out, 'review.pending.json'), pendingReview(bundle.bundleHash, bundle.candidateHash));
    fs.writeFileSync(path.join(out, 'REVIEW.md'), reviewText(bundle, render), { flag: 'wx' });
    return { bundleHash: bundle.bundleHash, out, status: bundle.admission };
  } catch (error) {
    L.writeJson(path.join(out, 'failure.json'), { status: 'failed-no-admission', startedAt,
      failedAt: new Date().toISOString(), error: error.message });
    throw error;
  } finally { L.removeScratch(out, scratch); }
}
function reviewText(bundle, render) {
  return '# Offline parameter candidate review\n\nCandidate: `' + bundle.candidateHash + '`  \nBundle: `' + bundle.bundleHash + '`\n\n'
    + 'Mechanical preparation and rendering do not approve this candidate. Copy review.pending.json outside the candidate generation input and complete every gate through an identifiable human review. Never use a model or a synthetic test record as approval.\n\n'
    + '| Profile | First frame ms | Warm frame p95 ms | First | Warm |\n| --- | ---: | ---: | --- | --- |\n'
    + render.profiles.map(item => '| ' + item.profile.name + ' | ' + item.firstFrameMs.toFixed(2) + ' | '
      + item.frameMs.p95.toFixed(2) + ' | [PNG](' + item.images[0].file + ') | [PNG](' + item.images[1].file + ') |').join('\n')
    + '\n\nRequired gates: visual (lyrics, skins, landscape and portrait), license (authorship and attribution), physicalDevice (weak devices, driver and DPI matrix), longRun (sustained resources), isolation (OS network, arbitrary IO, process memory and CPU limits), ownerIntegration (existing static owner, contract export, fixtures and package release).\n\n'
    + 'This local tool accepts only JSON numeric slots over fixed trusted templates. Browser requests are denied, the prepare process has a Node filesystem read allowlist, and workers have heap/work/time limits. Browser/driver whole-process memory and CPU quotas and OS-wide network/IO confinement are not established. The 90-frame probe is not a long-duration test. Timing includes gl.finish and cannot establish display FPS. Software WebGL results do not qualify physical devices.\n';
}
function verifyBundle(dir) {
  const bundle = L.readJson(path.join(dir, 'bundle.json'), L.LIMITS.outputBytes);
  const hash = bundle.bundleHash, identity = { ...bundle }; delete identity.bundleHash;
  L.ensure(L.digest(identity) === hash, 'bundle identity mismatch');
  L.ensure(bundle.bundleVersion === 1 && bundle.mechanical.renderer && bundle.mechanical.resourcesReleased, 'bundle mechanical gate failed');
  L.ensure(['canonicalPrepare', 'strictRanges', 'noClamping', 'roundtrip', 'pure']
    .every(key => bundle.mechanical.prepare[key] === true), 'bundle preparation gate failed');
  for (const [file, digest] of Object.entries(bundle.files)) {
    L.ensure(/^[a-z0-9-]+\.(json|txt|png)$/.test(file), 'invalid bundle filename');
    L.ensure(L.fileHash(path.join(dir, file)) === digest, 'bundle file hash mismatch: ' + file);
  }
  for (const required of ['candidate.json', 'toolchain-lock.json', 'share-code.txt', 'render-report.json'])
    L.ensure(Object.hasOwn(bundle.files, required), 'missing bundle member: ' + required);
  const candidate = L.readJson(path.join(dir, 'candidate.json'), L.LIMITS.outputBytes);
  const lock = L.readJson(path.join(dir, 'toolchain-lock.json'), L.LIMITS.outputBytes);
  L.ensure(candidate.prepared.proposalHash === bundle.candidateHash && candidate.lockHash === bundle.lockHash
    && L.digest(lock) === bundle.lockHash, 'candidate or lock binding mismatch');
  L.ensure(L.digest({ candidate: candidate.candidate, preset: candidate.prepared.preset }) === bundle.candidateHash, 'candidate content hash mismatch');
  L.ensure(candidate.candidateStatus === 'pending-human-review' && candidate.prepared.applied === false
    && candidate.prepared.persisted === false, 'candidate cannot claim approval or application');
  const render = L.readJson(path.join(dir, 'render-report.json'), L.LIMITS.outputBytes);
  L.ensure(render.passed && render.contextClosed && render.browserClosed && !render.errors.length
    && !render.deniedRequests.length && render.networkDenialProbe.navigationRejected
    && render.networkDenialProbe.interceptedRequests.length === 1, 'renderer completion or denial gate failed');
  const profiles = require('./stage-authoring-render.cjs').PROFILES;
  L.ensure(render.profiles.length === profiles.length, 'render profile matrix incomplete');
  for (let index = 0; index < profiles.length; index++) {
    const item = render.profiles[index];
    L.ensure(L.canonical(item.profile) === L.canonical(profiles[index]), 'render profile mismatch');
    L.ensure(item.passed && item.contextLost && item.rejectedAfterLoss && item.recreated
      && item.frames === L.LIMITS.frames && item.resources.released
      && Object.values(item.resources.after).every(value => value === 0)
      && !item.resources.violations.length && !item.resources.rejections, 'render or resource gate failed');
    L.ensure(item.images.length === 2 && item.images.every(image => image.visiblePixels > 0
      && Object.hasOwn(bundle.files, image.file)), 'render image matrix incomplete');
  }
  L.verifyLock(lock);
  return { bundle, candidate, lock };
}
function validateReview(review, bundle) {
  L.exact(review, ['reviewVersion', 'bundleHash', 'candidateHash', 'gates']);
  L.ensure(review.reviewVersion === 1 && review.bundleHash === bundle.bundleHash && review.candidateHash === bundle.candidateHash, 'review must bind to this exact bundle and candidate');
  L.exact(review.gates, L.REVIEW_GATES);
  for (const name of L.REVIEW_GATES) {
    const gate = review.gates[name]; L.exact(gate, ['status', 'reviewer', 'reviewedAt', 'evidence', 'notes']);
    L.ensure(gate.status === 'approved', 'admission blocked: ' + name + ' review is pending or rejected');
    L.plain(gate.reviewer, name + ' reviewer', 120);
    L.ensure(!/\b(ai|model|agent|codex|chatgpt|synthetic|test)\b/i.test(gate.reviewer), 'human reviewer required');
    L.ensure(typeof gate.reviewedAt === 'string' && Number.isFinite(Date.parse(gate.reviewedAt))
      && Date.parse(gate.reviewedAt) <= Date.now() && Date.parse(gate.reviewedAt) >= Date.parse(bundle.finishedAt), 'invalid review time');
    L.plain(gate.evidence, name + ' evidence reference', 240);
    L.plain(gate.notes, name + ' review rationale', 1000);
  }
  return true;
}
async function checkAdmission(dir, reviewPath, out) {
  const { bundle, candidate, lock } = verifyBundle(dir), review = L.readJson(reviewPath);
  validateReview(review, bundle);
  const parent = path.dirname(out), scratch = fs.mkdtempSync(path.join(parent, '.authoring-admission-'));
  try {
    const sourceRoot = snapshotSources(scratch, lock);
    const revalidated = await L.runWorker(path.join(sourceRoot, 'scripts/stage-authoring-prepare.cjs'),
      { input: candidate.candidate, sourceRoot }, { cwd: scratch, permissionRead: sourceRoot,
        heapMiB: L.LIMITS.prepareHeapMiB, timeoutMs: L.LIMITS.prepareMs });
    L.ensure(L.canonical(revalidated.value.prepared) === L.canonical(candidate.prepared), 'reviewed candidate no longer materializes exactly');
  } finally { L.removeScratch(parent, scratch); }
  // This is a reviewable static data handoff, never a registry mutation or executable fragment.
  const handoff = { handoffVersion: 1, bundleHash: bundle.bundleHash, candidateHash: bundle.candidateHash,
    reviewedBy: review.gates, targetOwner: 'plugin/ui/creative-templates.js',
    candidate: candidate.candidate, prepared: candidate.prepared,
    instructions: 'Maintainer integrates with the existing static template owner; contract export, fixtures and packaged release are a separate reviewed source change.' };
  L.writeJson(out, handoff); return { out, status: 'static-maintainer-handoff-only' };
}
async function main(argv) {
  const [command, ...tail] = argv, opts = options(tail);
  if (command === 'pin') {
    requireOptions(opts, ['--playwright', '--browser', '--out']);
    L.writeJson(opts['--out'], L.makeLock(opts['--playwright'], opts['--browser']));
    return { out: opts['--out'], status: 'toolchain-identity-recorded-not-approved' };
  }
  if (command === 'build') { requireOptions(opts, ['--input', '--lock', '--out']); return build(opts['--input'], opts['--lock'], opts['--out']); }
  if (command === 'admit') { requireOptions(opts, ['--bundle', '--review', '--out']); return checkAdmission(opts['--bundle'], opts['--review'], opts['--out']); }
  throw new Error('usage: stage-authoring.cjs pin --playwright DIR --browser EXE --out LOCK | build --input JSON --lock LOCK --out NEW_DIR | admit --bundle DIR --review JSON --out NEW_JSON');
}
if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { build, verifyBundle, pendingReview, validateReview, checkAdmission, main };
