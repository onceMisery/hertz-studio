// SPDX-License-Identifier: MIT
// Entire production AI UI script with fixture transport/DOM and native target facts.
// This is a projection regression check, not multi-monitor Windows qualification.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sourceArgument = process.argv.indexOf('--source');
const sourcePath = sourceArgument < 0 ? path.join(root, 'crates/hertz-desktop/assets/wallpaper-ai.js') : path.resolve(process.argv[sourceArgument + 1]);
const source = fs.readFileSync(sourcePath, 'utf8');
const work = { workKey: 'local-exact-work', packageHash: 'a'.repeat(64) };
const messages = { saved: '已保存，等待桌面首次呈现。', running: '已保存，正在运行。', paused: '已保存，当前暂停。', failed: '操作未完成，请查看具体原因。' };
const checks = [];
class FixtureNode {
  constructor() { this.listeners = new Map(); this.children = []; this.dataset = {}; this.value = ''; this.textContent = ''; this.disabled = false; this.open = false; this.classList = { toggle() {} }; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  replaceChildren() { this.children = []; }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  querySelectorAll() { return []; }
  async fire(name) { const handler = this.listeners.get(name); if (handler) await handler(); }
}
function ready(overrides = {}) {
  return { groupId: 'main', targetId: 'first', state: 'running', enabled: true, runtimeEnabled: true,
    sessionStopped: false, firstFrameReady: true, pageReady: true, visible: true, monitorMissing: false,
    applyError: null, session: { state: 'running' }, appliedSelection: { kind: 'package', ...work }, ...overrides };
}
function cohort(second, first = ready()) { return { ...first, targets: [first, ready({ targetId: 'second', ...second })] }; }
async function harness(options = {}) {
  const ids = ['wallpaper-ai', 'ai-query', 'ai-brief', 'ai-target', 'ai-message', 'ai-results', 'ai-loading'];
  const nodes = Object.fromEntries(ids.map(id => [id, new FixtureNode()]));
  const window = new FixtureNode();
  const state = { context: { groupId: 'main', revision: 7, profile: 'fixture' }, runtime: null, records: [], pending: [], runs: [] };
  const receipt = (record, phase = 'saved') => ({ ai: { requestId: record.requestId, phase, saved: true, groupId: record.groupId, ...work } });
  function defer(record) { return new Promise((resolve, reject) => state.pending.push({ record, resolve, reject })); }
  window.hertzWallpaperSettings = {
    currentAiContext: () => state.context,
    currentRuntime: () => state.runtime,
    async requestManagement(command, payload, requestId) {
      if (command === 'wallpaper.ai.target') return { result: { groupId: payload.groupId, configRevision: state.context.revision, members: [] } };
      if (command === 'wallpaper.operations.get') return defer(state.records.find(record => record.requestId === payload.requestId));
      assert.equal(command, 'wallpaper.ai.recommend');
      const record = { requestId, groupId: state.context.groupId, index: state.records.length }; state.records.push(record);
      if (options.recover) throw Object.assign(new Error('receipt delayed'), { code: 'receipt_timeout' });
      return options.delayed ? defer(record) : receipt(record);
    },
  };
  const document = Object.assign(new FixtureNode(), { hidden: false, getElementById: id => nodes[id], createElement: () => new FixtureNode() });
  vm.runInNewContext(source, { window, document, crypto }, { filename: sourcePath });
  nodes['wallpaper-ai'].open = true; await nodes['wallpaper-ai'].fire('toggle');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(nodes['ai-query'].disabled, false);
  nodes['ai-brief'].value = '切换到确切作品'; state.runs.push(nodes['ai-query'].fire('click'));
  if (!options.delayed && !options.recover) { await state.runs[0]; assert.ok(nodes['ai-message'].textContent.startsWith(messages.saved)); }
  await Promise.resolve(); await Promise.resolve();
  return {
    nodes,
    async nativeProgress(phase, index = 0) { window.hertzWallpaperAI.applyProgress(receipt(state.records[index], phase).ai); await Promise.resolve(); },
    async finish(index = 0, result = {}) {
      const pending = state.pending[index]; assert.ok(pending, 'actual management promise is pending');
      if (result.error) pending.reject(Object.assign(new Error('late old operation error'), { code: result.error }));
      else pending.resolve(result.result ? { result: result.result } : options.recover ? { result: { saved: true } } : receipt(pending.record, result.phase || 'running'));
      await state.runs[pending.record.index]; await Promise.resolve(); await Promise.resolve();
    },
    startQuery() { state.runs.push(nodes['ai-query'].fire('click')); },
    async project(runtime, phase, label) {
      state.runtime = runtime; await window.fire('wallpaper-ai-context');
      assert.ok(nodes['ai-message'].textContent.startsWith(messages[phase]), label + ': ' + nodes['ai-message'].textContent);
      checks.push(label);
    },
    async changeContext(patch) { state.context = { ...state.context, ...patch }; await window.fire('wallpaper-ai-context'); await Promise.resolve(); await Promise.resolve(); },
    async changeGroup(groupId) { state.context = { ...state.context, groupId }; await window.fire('wallpaper-ai-context'); await Promise.resolve(); await Promise.resolve(); },
    async close() { nodes['wallpaper-ai'].open = false; await nodes['wallpaper-ai'].fire('toggle'); },
    async reopen() { nodes['wallpaper-ai'].open = true; await nodes['wallpaper-ai'].fire('toggle'); await Promise.resolve(); await Promise.resolve(); },
    async invalidate() { await window.fire('wallpaper-ai-invalidated'); await Promise.resolve(); await Promise.resolve(); },
    async pagehide() { await window.fire('pagehide'); },
    async hide() { document.hidden = true; await document.fire('visibilitychange'); },
  };
}
async function main() {
  const cases = [
    [ready(), 'running', 'original single target exact first-frame running'],
    [{ ...ready(), targets: [ready()] }, 'running', 'current single-target array remains running'],
    [ready({ visible: false, state: 'paused', session: { state: 'paused' } }), 'paused', 'original single target paused'],
    [cohort({}), 'running', 'all exact ready visible mirror targets are running'],
    [cohort({ visible: false, state: 'paused', session: { state: 'paused' } }), 'paused', 'second mirror target paused cannot be upgraded by visible first target'],
    [cohort({ firstFrameReady: false, state: 'preparing' }), 'saved', 'second mirror pageReady without real first frame remains saved'],
    [cohort({ appliedSelection: { kind: 'package', ...work, workKey: 'old-work' } }), 'saved', 'second mirror old work identity remains saved'],
    [cohort({ appliedSelection: { kind: 'package', ...work, packageHash: 'b'.repeat(64) } }), 'saved', 'second mirror old package hash remains saved'],
    [cohort({}, ready({ firstFrameReady: false, state: 'preparing' })), 'saved', 'target order cannot hide a missing first frame'],
    [cohort({ applyError: { code: 'target_failed' }, state: 'failed' }), 'failed', 'second mirror native failure is preserved'],
    [cohort({ state: 'paused' }), 'paused', 'native paused state wins over retained visible first frame'],
    [cohort({ state: 'stopped' }), 'paused', 'closing target serialized as stopped cannot become running'],
    [cohort({ state: 'closing' }), 'paused', 'closing state cannot become running'],
    [cohort({ sessionStopped: true }), 'paused', 'session stop wins over retained visible first frame'],
    [cohort({ runtimeEnabled: false }), 'paused', 'disabled runtime cannot become running'],
    [cohort({ enabled: false, state: 'disabled' }), 'paused', 'disabled target cannot become running'],
    [cohort({ monitorMissing: true, state: 'missing' }), 'saved', 'missing mirror target cannot become running'],
    [cohort({ groupId: 'other-group' }), 'saved', 'another group target cannot satisfy the authorized cohort'],
    [{ ...ready(), targets: [] }, 'saved', 'empty actual target cohort cannot become running'],
    [null, 'saved', 'absent actual runtime cannot become running'],
  ];
  for (const [runtime, phase, label] of cases) await (await harness()).project(runtime, phase, label);
  const transition = await harness();
  await transition.project(cohort({}), 'running', 'running cohort baseline for later status changes');
  await transition.project(cohort({ firstFrameReady: false, state: 'preparing' }), 'saved', 'later missing first frame demotes earlier running');
  await transition.project(cohort({ visible: false, state: 'paused' }), 'paused', 'later second-target pause keeps whole group paused');
  await transition.project(cohort({}), 'running', 'full cohort resumes running after actual readiness');
  await transition.changeGroup(null);
  assert.ok(transition.nodes['ai-message'].textContent.includes('先建立并保存一个显示组'), 'missing selected target message is not replaced by the old running operation');
  checks.push('missing selected group preserves target-required message');
  const changed = await harness(); await changed.project(cohort({}), 'running', 'old authorized group running before target selection changes');
  await changed.changeGroup('other-group');
  assert.ok(!changed.nodes['ai-message'].textContent.startsWith(messages.running), 'new selected group is not assigned the old operation running phase');
  checks.push('new selected group cannot inherit old operation running phase');

  const leaveScopes = [
    ['missing group', test => test.changeGroup(null)],
    ['another group', test => test.changeGroup('other-group')],
    ['another Profile with the same group', test => test.changeContext({ profile: { edition: 'standard', installation: 'other-profile' } })],
    ['closed panel', test => test.close()],
    ['invalidated action', test => test.invalidate()],
    ['pagehide', test => test.pagehide()],
    ['hidden document', test => test.hide()],
  ];
  for (const [name, leave] of leaveScopes) {
    const native = await harness(); await leave(native); const nativeMessage = native.nodes['ai-message'].textContent;
    await native.nativeProgress('running'); await native.nativeProgress('failed');
    assert.equal(native.nodes['ai-message'].textContent, nativeMessage, name + ' rejects late direct native progress');
    checks.push(name + ' rejects late direct native progress');

    const delayed = await harness({ delayed: true }); await leave(delayed); const delayedMessage = delayed.nodes['ai-message'].textContent;
    await delayed.finish(); assert.equal(delayed.nodes['ai-message'].textContent, delayedMessage, name + ' rejects late receipt.ai');
    checks.push(name + ' rejects late management receipt.ai');

    const failed = await harness({ delayed: true }); await leave(failed); const errorMessage = failed.nodes['ai-message'].textContent;
    await failed.finish(0, { error: 'request_failed' }); assert.equal(failed.nodes['ai-message'].textContent, errorMessage, name + ' rejects late promise error');
    checks.push(name + ' rejects late management promise error');

    const recovered = await harness({ recover: true }); await leave(recovered); const recoveredMessage = recovered.nodes['ai-message'].textContent;
    await recovered.finish(); assert.equal(recovered.nodes['ai-message'].textContent, recoveredMessage, name + ' rejects late journal recovery receipt');
    checks.push(name + ' rejects late journal recovery receipt');

    const recoveryError = await harness({ recover: true }); await leave(recoveryError); const recoveryMessage = recoveryError.nodes['ai-message'].textContent;
    await recoveryError.finish(0, { error: 'query_failed' }); assert.equal(recoveryError.nodes['ai-message'].textContent, recoveryMessage, name + ' rejects late journal recovery error');
    checks.push(name + ' rejects late journal recovery error');
  }
  const committed = await harness({ delayed: true });
  await committed.nativeProgress('accepted'); await committed.changeContext({ revision: 8 });
  await committed.nativeProgress('saved'); assert.ok(committed.nodes['ai-message'].textContent.startsWith(messages.saved));
  await committed.nativeProgress('running'); assert.ok(committed.nodes['ai-message'].textContent.startsWith(messages.running));
  await committed.finish(); assert.ok(committed.nodes['ai-message'].textContent.startsWith(messages.running));
  checks.push('same-group self-commit revision refresh keeps native progress and receipt.ai receiver live');
  const savedCommit = await harness(); await savedCommit.project(cohort({}), 'running', 'same-group saved operation has exact target first frame');
  await savedCommit.changeContext({ revision: 8 });
  assert.ok(savedCommit.nodes['ai-message'].textContent.startsWith(messages.running), 'same-group readTarget refresh cannot overwrite legal terminal progress');
  checks.push('same-group readTarget refresh preserves legal terminal phase');
  const recoveredCommit = await harness({ recover: true }); await recoveredCommit.changeContext({ revision: 8 }); await recoveredCommit.finish();
  assert.ok(recoveredCommit.nodes['ai-message'].textContent.startsWith(messages.saved));
  checks.push('same-group self-commit allows original journal recovery receipt');

  const reopened = await harness(); await reopened.close(); await reopened.reopen(); const reopenedMessage = reopened.nodes['ai-message'].textContent;
  await reopened.nativeProgress('running'); assert.equal(reopened.nodes['ai-message'].textContent, reopenedMessage, 'reopened same-scope panel has retired old receiver');
  checks.push('closing then reopening the same group cannot revive the old native receiver');
  const superseded = await harness({ delayed: true }); await superseded.changeGroup('other-group'); superseded.startQuery();
  assert.equal(superseded.nodes['ai-loading'].hidden, false); const newMessage = superseded.nodes['ai-message'].textContent;
  await superseded.nativeProgress('failed', 0); assert.equal(superseded.nodes['ai-message'].textContent, newMessage);
  checks.push('old request native progress cannot enter a new live group receiver');
  await superseded.finish(0);
  assert.equal(superseded.nodes['ai-message'].textContent, newMessage); assert.equal(superseded.nodes['ai-loading'].hidden, false);
  await superseded.finish(1); assert.ok(superseded.nodes['ai-message'].textContent.startsWith(messages.running));
  checks.push('old promise receipt and finally cannot overwrite or unlock a new group receiver');

  const staleRows = await harness({ delayed: true }); await staleRows.changeContext({ revision: 8 });
  await staleRows.finish(0, { result: { actions: [], message: 'stale recommendation result' } });
  assert.notEqual(staleRows.nodes['ai-message'].textContent, 'stale recommendation result');
  checks.push('advisory render keeps the original revision epoch fence');
  process.stdout.write(JSON.stringify({ passed: true, sourcePath, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), checks }, null, 2) + '\n');
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
