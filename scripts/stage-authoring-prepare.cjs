// SPDX-License-Identifier: MIT
// Separate permission-limited process; only fixed repository code enters vm.
// node:vm is a fixture namespace, NOT the security boundary for arbitrary code.
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const L = require('./stage-authoring-lib.cjs');

async function prepare(input, sourceRoot) {
  input = L.boundedJson(JSON.stringify(input));
  const denied = () => { throw new Error('IO is unavailable in the data-only fixture'); };
  const box = { window: {}, console: { log() {}, warn() {}, error() {} }, TextEncoder, TextDecoder,
    btoa: text => Buffer.from(text, 'binary').toString('base64'),
    atob: text => Buffer.from(text, 'base64').toString('binary'),
    document: { addEventListener() {}, getElementById() { return null; },
      body: { classList: { contains() { return false; } } } },
    fetch: denied, XMLHttpRequest: denied, WebSocket: denied, setTimeout: denied, setInterval: denied };
  vm.createContext(box, { codeGeneration: { strings: false, wasm: false } });
  for (const name of L.UI_FILES) {
    const file = path.join(sourceRoot, 'plugin/ui', name);
    vm.runInContext(fs.readFileSync(file, 'utf8'), box, { filename: name, timeout: 1000 });
    Object.assign(box, box.window);
    if (name === 'stage-resource-policy.js') {
      const ledger = box.StageResourceBudget.create(box.StageResourcePolicy);
      box.Stage = box.window.Stage = { resources: () => ledger };
    }
  }
  L.validateInput(input, box.CreativeStageContract, box.CreativeTemplates.list());
  const before = box.CreativeStage.preset();
  const result = await box.CreativeDraft.prepare(input.artifact);
  L.ensure(result.diagnostics.every(item => !item.clamped), 'canonical normalization changed a slot; revise the candidate explicitly');
  result.preset.name = input.title;
  result.preset = box.CreativeStage.normalizeSharePreset(result.preset);
  result.shareCode = await box.CreativeShareCode.encode(result.preset, { compress: false });
  const decoded = await box.CreativeShareCode.decode(result.shareCode);
  L.ensure(L.canonical(decoded) === L.canonical(result.preset), 'full preset share roundtrip failed');
  L.ensure(L.canonical(before) === L.canonical(box.CreativeStage.preset()), 'draft preparation mutated committed state');
  L.ensure(Object.values(box.Stage.resources().snapshot().held).every(value => value === 0), 'prepare fixture retained resources');
  return { candidate: input, prepared: { artifact: result.artifact, preset: result.preset,
    diagnostics: result.diagnostics, shareCode: result.shareCode,
    proposalHash: L.digest({ candidate: input, preset: result.preset }), persisted: false, applied: false },
    validation: { canonicalPrepare: true, strictRanges: true, noClamping: true, roundtrip: true, pure: true },
    provenance: { recipe: input.provenance, upstream: { owner: 'plugin/ui/creative-gl.js',
      templateOwner: 'plugin/ui/creative-templates.js', license: 'MIT',
      licenseSha256: L.fileHash(path.join(sourceRoot, 'LICENSE')) } },
    process: { node: process.version, permissionModel: !!process.permission,
      envKeys: Object.keys(process.env).sort(), maxRssKiB: process.resourceUsage().maxRSS,
      cpuMicroseconds: process.cpuUsage() } };
}
if (require.main === module) {
  L.scrubProcessEnv(process.cwd());
  L.stdinJson().then(async payload => {
    const result = await prepare(payload.input, payload.sourceRoot);
    process.stdout.write(JSON.stringify(result));
  }).catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
}
module.exports = { prepare };
