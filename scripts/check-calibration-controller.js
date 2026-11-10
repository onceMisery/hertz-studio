// SPDX-License-Identifier: MIT
// Read-only production-controller regression. No browser/native launch or file writes.
// A later frame must not prevent expiry or overwrite a newer request.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'plugin/ui/app.js');
const sourceBytes = fs.readFileSync(sourcePath);
const source = sourceBytes.toString('utf8');
const start = source.indexOf('const calibrationUi = (() => {');
const end = source.indexOf('\n})();', start) + 6;
assert.ok(start >= 0 && end > start, 'Production calibrationUi section exists');

let now = 0, timerTick, opened = false, claimed = false;
let pending = { version: 1, requestId: 'A', session: 'source', trackId: 'first', generation: '1' };
let lastClaim = '';
const deadlines = { A: 4500, B: 10500 };
const calls = [], frames = [], nodes = new Map();
let context;
function node(id) {
  if (!nodes.has(id)) nodes.set(id, {
    disabled: false, checked: false, hidden: false, textContent: '',
    scrollIntoView() {},
    focus() { context.document.activeElement = this; },
    closest() { return null; },
    getBoundingClientRect() { return { width: 40, height: 20 }; },
  });
  return nodes.get(id);
}

context = {
  performance: { now: () => now },
  state: { connected: true, current: { id: 'first' }, snapshot: { generation: 1 } },
  np: { lyricOffset: node('offset'), lyricOffsetDown: node('down') },
  $: node,
  transport: {
    async get() { return { authorized: true, source: 'imported', lines: [{ text: 'current lyric' }] }; },
    async post(url, body) {
      calls.push({ ...body });
      if (body.op === 'register') return { receiverId: 'r1', session: 'source' };
      if (body.op === 'claim') {
        if (!pending || claimed) return { intent: null };
        claimed = true; lastClaim = pending.requestId;
        return { intent: { ...pending }, remainingMs: deadlines[pending.requestId] - now };
      }
      if (body.op === 'validate') {
        if (!pending || body.requestId !== pending.requestId || now >= deadlines[body.requestId]) throw Error('expired/unknown');
        return { valid: true, remainingMs: deadlines[body.requestId] - now };
      }
      if (body.op === 'renew') return { renewed: true };
      if (body.op === 'complete') return { state: body.result };
      return {};
    },
  },
  document: { visibilityState: 'visible', activeElement: null, hasFocus: () => false, addEventListener() {} },
  setInterval(fn) { timerTick = fn; return 1; },
  clearInterval() {},
  requestAnimationFrame(fn) { frames.push({ requestId: lastClaim, fn }); return frames.length; },
  openNowPlaying() { opened = true; },
  isNpOpen: () => opened,
  syncNpLyrics() {},
};
context.window = { focus() {}, addEventListener() {}, NowPlaying: { showCalibration() {} } };
vm.createContext(context);
vm.runInContext(source.slice(start, end) + '\nthis.auditController = calibrationUi;', context);
context.auditController.init();

async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function main() {
  await flush();
  assert.equal(frames.filter(f => f.requestId === 'A').length, 1, 'A reached the withheld frame');
  now = 3000;
  timerTick(); await flush();
  assert.equal(calls.filter(c => c.op === 'claim').length, 1, 'An unexpired request retains the single flight');
  now = 6000;
  pending = { ...pending, requestId: 'B' }; claimed = false;
  for (let i = 0; i < 8; i++) { timerTick(); await flush(); }
  const expired = {
    claimCount: calls.filter(c => c.op === 'claim').length,
    renewCount: calls.filter(c => c.op === 'renew').length,
    completeCount: calls.filter(c => c.op === 'complete').length,
    secondRequestClaimed: claimed,
  };
  const beforeLate = calls.length;
  frames.find(f => f.requestId === 'A').fn(); await flush();
  const lateOldRequestActions = calls.slice(beforeLate).filter(c => c.requestId === 'A');
  assert.deepEqual(lateOldRequestActions, [], 'Late A frame cannot validate/complete after deadline/context replacement');
  const bFrame = frames.find(f => f.requestId === 'B');
  if (bFrame) {
    context.document.visibilityState = 'visible';
    context.document.hasFocus = () => true;
    bFrame.fn(); await flush();
  }
  const secondRequestCompleted = calls.some(c => c.op === 'complete' && c.requestId === 'B' && c.result === 'shown');
  const output = {
    kind: 'Production calibrationUi in Node VM; withheld-frame model, no browser/native or OS-focus qualification',
    sourcePath,
    sourceSha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
    expired,
    lateOldRequestActions: lateOldRequestActions.length,
    secondRequestCompleted,
  };
  console.log(JSON.stringify(output, null, 2));
  assert.equal(expired.secondRequestClaimed, true, 'Deadline must release old flight before its frame arrives');
  assert.equal(secondRequestCompleted, true, 'Late old frame must not clear the newer active request');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
