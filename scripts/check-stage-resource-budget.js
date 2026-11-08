'use strict';
// Post-implementation invariants for the production ledger, independent of renderer behavior.
const assert = require('node:assert/strict');
const budget = require('../plugin/ui/stage-resource-budget.js');
const caps = Object.fromEntries(budget.dimensions.map(key => [key, 100]));
const policy = { contractVersion: 1, policyVersion: 'contract-fixture-v1', qualification: 'test-only', caps };
const plan = (resourceId, bytes, extra = {}) => ({ owner: 'renderer', resourceId, requestId: resourceId + '-request',
  lifetimeId: 'renderer-lifetime', generation: 1, planVersion: 1,
  basis: { precision: 'exact-declared', source: 'fixture declared capacity' }, resources: { ownedCpuBytes: bytes }, ...extra });
const proof = { apiReleased: true, allocationEnded: true };
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS ' + name); }

check('finite complete caps and trustworthy scalar plans are mandatory', () => {
  assert.throws(() => budget.create({ ...policy, caps: { ownedCpuBytes: 100 } }));
  assert.throws(() => budget.create({ ...policy, caps: { ...caps, gpuContexts: Infinity } }));
  assert.throws(() => budget.create({ ...policy, caps: { ...caps, canvases: -1 } }));
  const ledger = budget.create(policy);
  assert.equal(ledger.reserve(plan('a', 1, { basis: null })).ok, false);
  assert.equal(ledger.reserve(plan('a', 1.5)).ok, false);
  assert.equal(ledger.reserve(plan('a', 1, { policyVersion: 'old' })).ok, false);
  assert.equal(ledger.snapshot().resources, 0);
});
check('synchronous competing requests cannot oversubscribe a dimension', () => {
  const ledger = budget.create(policy);
  assert.equal(ledger.reserve(plan('first', 60)).ok, true);
  const second = ledger.reserve(plan('second', 60));
  assert.equal(second.ok, false); assert.equal(second.reason, 'aggregate-budget');
  assert.deepEqual(second.dimensions, ['ownedCpuBytes']);
  assert.equal(ledger.snapshot().pending.ownedCpuBytes, 60);
});
check('stagewise pending to live does not add a second reservation', () => {
  const ledger = budget.create(policy), ticket = ledger.reserve(plan('a', 80)).ticket;
  assert.equal(ticket.materialize({ ownedCpuBytes: 30 }).ok, true);
  assert.equal(ledger.snapshot().held.ownedCpuBytes, 80);
  assert.equal(ledger.snapshot().live.ownedCpuBytes, 30);
  ticket.settle({ allocationEnded: true });
  assert.equal(ledger.snapshot().held.ownedCpuBytes, 30);
  assert.equal(ticket.release({ apiReleased: true }).ok, false);
  ticket.release(proof); assert.equal(ledger.snapshot().resources, 0);
});
check('replacement and shrink both hold old plus full new capacity before cleanup', () => {
  const ledger = budget.create({ ...policy, caps: { ...caps, ownedCpuBytes: 20 } });
  const old = ledger.reserve(plan('old', 8)).ticket; old.commit();
  const replacement = ledger.reserve(plan('replacement', 12)).ticket;
  assert.equal(ledger.snapshot().held.ownedCpuBytes, 20);
  replacement.commit(); old.release(proof);
  const small = ledger.reserve(plan('small', 4)).ticket;
  assert.equal(ledger.snapshot().held.ownedCpuBytes, 16);
  small.commit(); replacement.release(proof); small.release(proof);
  assert.equal(ledger.snapshot().peak.ownedCpuBytes, 20);
});
check('cancel and timeout do not reclaim an initializer that can still allocate', () => {
  const ledger = budget.create(policy), ticket = ledger.reserve(plan('slow', 80)).ticket;
  ticket.cancel();
  assert.equal(ledger.snapshot().pending.ownedCpuBytes, 80);
  assert.equal(ticket.settle({ allocationEnded: false }).ok, false);
  assert.equal(ledger.reserve(plan('other', 30)).ok, false);
  const late = ticket.materialize({ ownedCpuBytes: 80 });
  assert.equal(late.ok, true); assert.equal(late.cancelled, true);
  assert.equal(ledger.snapshot().live.ownedCpuBytes, 80);
  ticket.settle({ allocationEnded: true }); ticket.release(proof);
  assert.equal(ledger.snapshot().held.ownedCpuBytes, 0);
});
check('already-materialized overrun is visible and blocks further admission', () => {
  const ledger = budget.create({ ...policy, caps: { ...caps, ownedCpuBytes: 20 } });
  const ticket = ledger.reserve(plan('bad', 10)).ticket;
  assert.equal(ticket.materialize({ ownedCpuBytes: 25 }).reason, 'contract-violation');
  assert.equal(ledger.snapshot().held.ownedCpuBytes, 25);
  assert.equal(ledger.reserve(plan('next', 1)).ok, false);
  ticket.release(proof); assert.equal(ledger.snapshot().live.ownedCpuBytes, 0);
});
check('shared resource references cannot allocate twice or retire protected uses', () => {
  const ledger = budget.create(policy), allocation = ledger.reserve(plan('shared', 40)).ticket;
  allocation.commit();
  const repeated = ledger.reserve(plan('shared', 40, { requestId: 'home' }));
  assert.equal(repeated.referenced, true); assert.equal(repeated.ticket.kind, 'lease');
  assert.equal(repeated.ticket.materialize, undefined);
  const stage = ledger.retain('shared', { owner: 'stage', useId: 'stage' });
  assert.equal(ledger.snapshot().live.ownedCpuBytes, 40);
  assert.equal(allocation.release(proof).reason, 'resource-in-use');
  repeated.ticket.release(); stage.ticket.release(); allocation.release(proof);
  assert.equal(ledger.snapshot().resources, 0);
});
check('stale identities and cleanup cannot damage a replacement generation', () => {
  const ledger = budget.create(policy), first = ledger.reserve(plan('a', 20)).ticket;
  first.commit();
  assert.equal(first.commit().duplicate, true);
  assert.equal(first.commit({ ownedCpuBytes: 20 }).duplicate, true);
  assert.equal(first.commit({ ownedCpuBytes: 21 }).ok, false);
  assert.equal(ledger.reserve(plan('a', 20, { generation: 2 })).ok, false);
  first.release(proof);
  const second = ledger.reserve(plan('a', 30, { generation: 2 })).ticket; second.commit();
  first.release(proof); first.cancel();
  assert.equal(ledger.snapshot().live.ownedCpuBytes, 30);
  second.release(proof); second.release(proof);
  assert.equal(ledger.snapshot().held.ownedCpuBytes, 0);
});
check('closing the page blocks new admission but retains cleanup obligations', () => {
  const ledger = budget.create(policy), ticket = ledger.reserve(plan('a', 10)).ticket;
  ledger.close(); assert.equal(ledger.reserve(plan('b', 10)).ok, false);
  assert.equal(ledger.snapshot().pending.ownedCpuBytes, 10);
  ticket.release(proof); assert.equal(ledger.snapshot().resources, 0);
});
check('diagnostics are passive and scalar reports retain request versus actual state', () => {
  const ledger = budget.create(policy), port = ledger.port('creative', 'fixed-renderer');
  port.report({ logicalInstanceId: 'old', requestId: 'new', lifecycle: 'ready', requestedQuality: 'high',
    actualQuality: 'medium', presentation: 'paused', reasons: ['aggregate-budget', 'frame-pressure'] });
  assert.throws(() => port.report({ renderer: {} }));
  assert.throws(() => port.report({ owner: 'space' }));
  const exported = ledger.snapshot(true);
  exported.hosts[0].reasons.push('injected');
  assert.deepEqual(ledger.snapshot(true).hosts[0].reasons, ['aggregate-budget', 'frame-pressure']);
  const a = port.reserve({ generation: 1, planVersion: 1, resources: { ownedCpuBytes: 90 },
    basis: { precision: 'bounded-estimate', source: 'validated renderer envelope' } });
  a.ticket.commit();
  for (let i = 0; i < 10; i++) ledger.snapshot(false);
  assert.equal(port.reserve({ generation: 1, planVersion: 1, resources: { ownedCpuBytes: 20 },
    basis: { precision: 'bounded-estimate', source: 'candidate' } }).ok, false);
  assert.equal(ledger.snapshot(true).hosts[0].actualQuality, 'medium');
  port.forgetReport(); a.ticket.release(proof);
});
check('release notifications are coalesced and observers cannot alter the transaction', () => {
  const callbacks = [], ledger = budget.create(policy, { defer: fn => callbacks.push(fn) });
  const port = ledger.port('particles'), events = [];
  const unsubscribe = port.onAvailable(() => events.push('available'));
  const first = ledger.reserve(plan('first', 20)).ticket, second = ledger.reserve(plan('second', 20)).ticket;
  first.commit(); second.commit(); first.release(proof); second.release(proof);
  assert.equal(callbacks.length, 1); assert.equal(events.length, 0);
  callbacks.shift()(); assert.deepEqual(events, ['available']);
  unsubscribe(); unsubscribe(); assert.equal(ledger.snapshot().listeners, 0);
});
console.log(JSON.stringify({ passed: true, checks, module: 'production StageResourceBudget', scope: 'deterministic contract verification' }));
