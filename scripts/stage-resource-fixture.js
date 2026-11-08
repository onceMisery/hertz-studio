// Test-only setup for narrow Creative codecs/materializers without a Stage DOM.
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
module.exports = function install(box) {
  for (const [name, file] of [['StageResourceBudget','stage-resource-budget.js'],
    ['StageResourcePolicy','stage-resource-policy.js'], ['StageJsonSource','stage-json-source.js']]) {
    if (!box.window[name]) vm.runInContext(fs.readFileSync(path.join(__dirname, '../plugin/ui', file), 'utf8'), box, { filename: file });
    box[name] = box.window[name];
  }
  const stage = box.Stage || box.window.Stage || {};
  if (!stage.resources) {
    const ledger = box.StageResourceBudget.create(box.StageResourcePolicy);
    stage.resources = () => ledger;
  }
  box.Stage = box.window.Stage = stage;
};
