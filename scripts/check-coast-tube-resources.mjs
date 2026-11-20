// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DynamicTube } from '../tools/coast-stage/src/util.js';
import { createScope } from '../tools/space-stage/src/scope.js';
const require = createRequire(import.meta.url), budget = require('../plugin/ui/stage-resource-budget.js');
const caps = Object.fromEntries(budget.dimensions.map(key => [key, 1e8]));
const ledger = budget.create({ contractVersion: 1, policyVersion: 'tube-contract', caps });
const scope = createScope({ resources: ledger.port('tube') });
const tube = new DynamicTube(18, 8, () => .2, scope), snapshot = ledger.snapshot(true);
const geometryBytes = (19 * 9 * 8 * 4) + (18 * 8 * 6 * 2);
const vectors = (tube._P.length + tube._T.length + tube.curve.points.length + 3) * 3 * 8;
assert.equal(geometryBytes, 7200); assert.equal(vectors, 1032);
assert.equal(snapshot.live.ownedCpuBytes, geometryBytes + vectors);
assert.equal(snapshot.pending.ownedCpuBytes, 0);
assert.equal(snapshot.pending.bufferDeclaredBytes, geometryBytes);
scope.dispose(); assert.equal(ledger.snapshot().resources, 0);
console.log(JSON.stringify({ passed: true, geometryBytes, retainedVectors: vectors, declaredCpu: snapshot.live.ownedCpuBytes }));
