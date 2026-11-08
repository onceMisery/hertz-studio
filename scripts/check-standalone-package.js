#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const { validateDescription, validatePe, validateDescriptionProtocol } = require('./package-standalone-windows');
const valid = { schemaVersion: 1, kind: 'hertz-studio', version: '0.3.2-preview', edition: 'full',
  target: 'x86_64-pc-windows-msvc', profile: 'release', compiler: 'rustc 1.88.0',
  buildId: 'a'.repeat(64), uiSha256: 'b'.repeat(64), desktopBuildId: 'c'.repeat(64),
  capabilities: { nativeWindow: true, windowsSystemMedia: true, embeddedDesktop: true, windowsInstallGuard: true } };
validateDescription(valid);
for (const patch of [{ edition: 'standard' }, { target: 'aarch64-apple-darwin' }, { profile: 'debug' },
  { version: '../escape' }, { buildId: 'commit-only' }, { uiSha256: null }, { kind: 'hertz-desktop' },
  { schemaVersion: 2 }, { capabilities: { ...valid.capabilities, nativeWindow: false } },
  { capabilities: { ...valid.capabilities, windowsInstallGuard: false } },
  { capabilities: { ...valid.capabilities, windowsSystemMedia: false } }]) {
  assert.throws(() => validateDescription({ ...valid, ...patch }), /Expected a Full/);
}
validateDescription({ ...valid, profile: 'debug' }, true);
assert.throws(() => validateDescription({ ...valid, edition: 'standard' }, true));
const pe = Buffer.alloc(256); pe.write('MZ'); pe.writeUInt32LE(128, 0x3c); pe.write('PE\0\0', 128);
pe.writeUInt16LE(0x8664, 132); pe.writeUInt16LE(0x20b, 152); validatePe(pe);
for (const machine of [0x14c, 0xaa64]) { const bytes = Buffer.from(pe); bytes.writeUInt16LE(machine, 132); assert.throws(() => validatePe(bytes)); }
for (const bytes of [Buffer.alloc(0), pe.subarray(0, 140)]) assert.throws(() => validatePe(bytes));
const malformed = Buffer.from(pe); malformed.writeUInt32LE(0xffffffff, 0x3c); assert.throws(() => validatePe(malformed));
assert.throws(() => validateDescriptionProtocol(pe), /description protocol/);
assert.throws(() => validateDescriptionProtocol(Buffer.from('--describe componentProtocol')), /description protocol/);
validateDescriptionProtocol(Buffer.from('--describe uiSha256 windowsSystemMedia'));
console.log('Windows package admission: wrong edition, feature, platform, profile, identity and malformed/wrong-architecture PE rejected; development allowance stays explicit.');
