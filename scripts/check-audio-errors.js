#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Verify the shipped UI branches on stable codes, preserves diagnostics, and
// never guesses decoder support from an error message or file extension.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'plugin/ui/app.js'), 'utf8');
const source = app.match(/function errText\(prefix, err\) \{[\s\S]*?\r?\n\}/);
assert.ok(source, 'Run the real UI error formatter');
const env = vm.createContext({});
vm.runInContext(source[0], env);
const text = (code, message, requestId) => env.errText('播放失败', {code, message, requestId});
const unsupported = text('unsupported_format', 'private decoder details', 'req-unsupported');
assert.match(unsupported, /Opus \/ APE \/ WMA/);
assert.match(unsupported, /FLAC \/ WAV/);
assert.match(unsupported, /改扩展名无效/);
assert.match(unsupported, /req-unsupported/);
assert.doesNotMatch(unsupported, /private decoder details/);
const failed = text('decode_failed', 'unsupported format: private.opus', 'req-read');
assert.match(failed, /读取或解码失败/);
assert.doesNotMatch(failed, /Opus|private.opus/);
assert.match(failed, /req-read/);
for (const code of [undefined, 'upstream_error', 'constructor', 'toString', '__proto__']) {
  assert.equal(text(code, '服务端原始说明'), '播放失败：服务端原始说明');
}
assert.equal(text(undefined, 'unsupported format: user filename.opus'),
  '播放失败：unsupported format: user filename.opus', 'No classification by English sentence or suffix');
console.log('PASS audio error guidance: stable codes, read/codec distinction, unknown-code fallback and request IDs');
