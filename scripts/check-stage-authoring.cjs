// SPDX-License-Identifier: MIT
// Post-implementation checks of offline input, process bounds and admission rejection.
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const L = require('./stage-authoring-lib.cjs');
const { prepare } = require('./stage-authoring-prepare.cjs');
const { pendingReview, validateReview, verifyBundle, checkAdmission } = require('./stage-authoring.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
async function main() {
  const input = L.readJson(path.join(L.ROOT, 'scripts/fixtures/stage-authoring/quiet-orb-study.json'));
  const good = await prepare(input, L.ROOT), again = await prepare(input, L.ROOT);
  assert.equal(L.canonical(good.prepared), L.canonical(again.prepared));
  assert.equal(good.validation.roundtrip, true); assert.equal(good.validation.pure, true);
  assert.equal(good.prepared.applied, false); assert.equal(good.prepared.persisted, false);
  const cases = [
    ['schema version', value => value.artifact.schemaVersion = '999'],
    ['schema hash', value => value.artifact.schemaHash = '0'.repeat(64)],
    ['baseline hash', value => value.artifact.basePresetHash = '0'.repeat(64)],
    ['template version', value => value.templateVersion = 999],
    ['out-of-range', value => value.artifact.intent.patch['sc.radius'] = 1e9],
    ['unknown slot', value => value.artifact.intent.patch['sc.arbitrary'] = 1],
    ['string slot', value => value.artifact.intent.patch['sc.radius'] = '2.5'],
    ['unknown license', value => value.provenance.license = 'UNKNOWN'],
    ['non-derivative license', value => value.provenance.license = 'CC-BY-ND-4.0'],
    ['approval input', value => value.approved = true],
    ['approval in provenance', value => value.provenance.approved = true],
    ['input script', value => value.script = 'process.exit(0)'],
    ['input GLSL', value => value.glsl = 'void main(){}'],
    ['URL asset', value => value.asset = 'https://example.invalid/asset.png'],
    ['path asset', value => value.asset = 'C:/private/image.png'],
    ['URL in text', value => value.provenance.sourceRef = 'https://example.invalid/source'],
    ['wrong scene', value => value.artifact.intent.scene = 'towers'],
    ['dynamic director', value => value.artifact.intent.director = true],
  ];
  for (const [label, mutate] of cases) {
    const bad = copy(input); mutate(bad); await assert.rejects(() => prepare(bad, L.ROOT), undefined, label);
  }
  assert.throws(() => L.boundedJson('{"__proto__":{}}'), /dangerous/);
  assert.throws(() => L.boundedJson(' '.repeat(L.LIMITS.inputBytes + 1)), /byte limit/);
  assert.throws(() => L.boundedJson(JSON.stringify({ nested: [[[[[[[[[[[1]]]]]]]]]]] })), /depth/);
  console.log('PASS canonical prepare, exact roundtrip, determinism, range/schema/license/code/approval rejection (' + cases.length + ' cases)');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-authoring-check-'));
  try {
    const hanging = path.join(temp, 'hang.cjs'), failing = path.join(temp, 'fail.cjs'), envProbe = path.join(temp, 'env.cjs'), denied = path.join(temp, 'denied.cjs');
    fs.writeFileSync(hanging, 'setInterval(() => {}, 1000);');
    fs.writeFileSync(failing, 'process.stderr.write("controlled failure"); process.exit(9);');
    fs.writeFileSync(envProbe, 'process.stdout.write(JSON.stringify({ leaked: !!process.env.STAGE_AUTHORING_TEST_SECRET, permission: !!process.permission }));');
    fs.writeFileSync(denied, 'require("node:fs").readFileSync(process.execPath);');
    const opts = { cwd: temp, timeoutMs: 1000, heapMiB: 32, permissionRead: temp };
    const started = performance.now();
    await assert.rejects(() => L.runWorker(hanging, {}, opts), /timeout/);
    assert.ok(performance.now() - started < 6000, 'worker termination must complete');
    const descendantFile = path.join(temp, 'descendant-pid.txt');
    fs.writeFileSync(hanging, 'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });\n'
      + 'require("node:fs").writeFileSync(' + JSON.stringify(descendantFile) + ', String(child.pid));\nsetInterval(() => {}, 1000);');
    await assert.rejects(() => L.runWorker(hanging, {}, { ...opts, permissionRead: undefined }), /timeout/);
    const descendantPid = Number(fs.readFileSync(descendantFile, 'utf8'));
    assert.throws(() => process.kill(descendantPid, 0), error => error.code === 'ESRCH', 'timeout must terminate descendants');
    await assert.rejects(() => L.runWorker(failing, {}, opts), /controlled failure/);
    await assert.rejects(() => L.runWorker(denied, {}, opts), /ERR_ACCESS_DENIED/);
    process.env.STAGE_AUTHORING_TEST_SECRET = 'must-not-cross-worker-boundary';
    const env = await L.runWorker(envProbe, {}, opts); delete process.env.STAGE_AUTHORING_TEST_SECRET;
    assert.deepEqual(env.value, { leaked: false, permission: true });
    console.log('PASS separate process timeout tree kill, failure, Node filesystem denial, sanitized environment');
  } finally { L.removeScratch(os.tmpdir(), temp); }

  const fake = { bundleHash: 'a'.repeat(64), candidateHash: 'b'.repeat(64), finishedAt: new Date(Date.now() - 60000).toISOString() };
  const pending = pendingReview(fake.bundleHash, fake.candidateHash);
  assert.throws(() => validateReview(pending, fake), /pending/);
  const all = copy(pending);
  // Validation-only fiction is never written to a bundle or used for export.
  for (const gate of Object.values(all.gates)) Object.assign(gate, { status: 'approved', reviewer: 'Synthetic test',
    reviewedAt: new Date().toISOString(), evidence: 'fixture-only', notes: 'Validation-only fictional attestation' });
  assert.throws(() => validateReview(all, fake), /human reviewer/);
  all.bundleHash = 'c'.repeat(64); assert.throws(() => validateReview(all, fake), /exact bundle/);
  console.log('PASS pending, synthetic and mismatched review cannot authorize admission');

  const bundleArg = process.argv.indexOf('--bundle');
  if (bundleArg >= 0) {
    const bundleDir = path.resolve(process.argv[bundleArg + 1]), verified = verifyBundle(bundleDir);
    const render = L.readJson(path.join(bundleDir, 'render-report.json'), L.LIMITS.outputBytes);
    assert.deepEqual(render.profiles.map(item => item.profile.name), ['low', 'medium', 'high', 'high-dpr2']);
    assert.ok(render.profiles.every(item => item.passed && item.contextLost && item.rejectedAfterLoss && item.recreated && item.resources.released));
    assert.ok(render.contextClosed && render.browserClosed);
    assert.equal(render.errors.length, 0); assert.equal(render.deniedRequests.length, 0);
    const allowedEnv = ['LANG', 'NODE_NO_WARNINGS', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'];
    for (const record of [render.process, verified.candidate.process])
      assert.ok(record.envKeys.every(key => allowedEnv.includes(key.toUpperCase())), 'workers scrub OS-added user/profile environment defaults');
    const exportPath = path.join(bundleDir, 'must-not-exist.json');
    await assert.rejects(() => checkAdmission(bundleDir, path.join(bundleDir, 'review.pending.json'), exportPath), /pending/);
    assert.equal(fs.existsSync(exportPath), false);
    const modifiedLock = copy(verified.lock); modifiedLock.sourceSha256['plugin/ui/creative-gl.js'] = '0'.repeat(64);
    assert.throws(() => L.verifyLock(modifiedLock), /source hash mismatch/);
    const modifiedToolchain = copy(verified.lock); modifiedToolchain.toolchain.node.version = 'v0.0.0';
    assert.throws(() => L.verifyLock(modifiedToolchain), /toolchain version or hash mismatch/);
    const tamper = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-authoring-tamper-'));
    try {
      fs.cpSync(bundleDir, tamper, { recursive: true });
      fs.appendFileSync(path.join(tamper, 'candidate.json'), '\n');
      assert.throws(() => verifyBundle(tamper), /file hash mismatch/);
    } finally { L.removeScratch(os.tmpdir(), tamper); }
    console.log('PASS real four-profile rendering, DPI, cleanup, pinned source integrity, fail-closed admission');
  }
  console.log('Stage authoring checks passed. Human and physical-device gates remain pending.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
