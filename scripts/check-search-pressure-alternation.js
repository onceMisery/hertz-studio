// SPDX-License-Identifier: MIT
'use strict';

const assert = require('node:assert/strict');
const { verifyAlternatingActualStart } = require('./check-search-pressure-evidence');

const rowsByKind = [
  [
    { kind: 0, sequence: 0, scheduledMs: 0, startLagMs: 0 },
    { kind: 0, sequence: 1, scheduledMs: 30, startLagMs: 0 },
  ],
  [
    { kind: 1, sequence: 0, scheduledMs: 10, startLagMs: 0 },
    { kind: 1, sequence: 1, scheduledMs: 20, startLagMs: 0 },
  ],
  [
    { kind: 2, sequence: 0, scheduledMs: 100, startLagMs: 0 },
    { kind: 2, sequence: 1, scheduledMs: 175, startLagMs: 0 },
  ],
  [
    { kind: 3, sequence: 0, scheduledMs: 125, startLagMs: 0 },
    { kind: 3, sequence: 1, scheduledMs: 150, startLagMs: 0 },
  ],
];
const counts = [2, 2, 2, 2];

assert.doesNotThrow(() => verifyAlternatingActualStart(rowsByKind, counts));

// Equal actual start times are not a reversal and have no new latency threshold.
rowsByKind[0][0].startLagMs = 10;
assert.doesNotThrow(() => verifyAlternatingActualStart(rowsByKind, counts));
rowsByKind[0][0].startLagMs = 0;

rowsByKind[0][0].startLagMs = 11;
assert.throws(() => verifyAlternatingActualStart(rowsByKind, counts),
  /Actual dispatch order reversed for 0\/1:0/);
rowsByKind[0][0].startLagMs = 0;

rowsByKind[2][0].startLagMs = 26;
assert.throws(() => verifyAlternatingActualStart(rowsByKind, counts),
  /Actual dispatch order reversed for 2\/3:0/);

console.log('search pressure actual-start alternation checks passed');
