'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

module.exports = async function verifyReferences({ api, native, settings, output, checks, until }) {
  const ref = draft => ({ draftId: draft.draftId, draftRevision: draft.draftRevision });
  const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt.result; };
  const work = ok(await api('wallpaper.draft.create', { kind: 'work', document: { title: '删除引用验证', sceneId: 'coast', stateVersion: 1, params: {} } }));
  const saved = ok(await api('wallpaper.draft.save', ref(work)));
  const published = ok(await api('wallpaper.draft.publish', ref(saved)));
  const selection = { kind: 'package', workKey: published.workKey, packageHash: published.packageHash };
  const query = { workKey: selection.workKey, packageHash: selection.packageHash };
  const original = path.join(output, 'packages', published.packageHash, 'original.hwpkg');
  const before = fs.readFileSync(original);
  const first = ok(await api('wallpaper.library.references', query));
  assert.equal(first.limit, 32); assert.equal(first.truncated, false);
  assert.ok(first.references.some(reference => reference.kind === 'workDraft' && reference.label === '删除引用验证'));
  const remove = { workKey: published.workKey, version: published.version, packageHash: published.packageHash };
  const refused = await api('wallpaper.library.deleteVersion', remove);
  assert.equal(refused.error.code, 'asset_in_use'); assert.deepEqual(refused.error.details, first);
  assert.deepEqual(fs.readFileSync(original), before);
  const mismatch = await api('wallpaper.library.references', { ...query, packageHash: 'b'.repeat(64) });
  assert.equal(mismatch.ok, false);
  ok(await api('wallpaper.draft.discard', ref(saved)));
  assert.deepEqual(ok(await api('wallpaper.library.references', query)).references, []);
  assert.equal(fs.existsSync(original), true, 'empty reference query never deletes content');
  checks.push('native query and asset_in_use receipt expose matching persisted draft references; clearing a draft makes read-only report empty without deleting bytes');

  const draft = ok(await api('wallpaper.draft.create', { kind: 'settings' }));
  const config = JSON.parse(fs.readFileSync(path.join(output, 'config.json'), 'utf8'));
  const configured = structuredClone((config.activeProfile ? config.profiles.find(domain => JSON.stringify(domain.profile) === JSON.stringify(config.activeProfile)) : config.unboundDomain).wallpaper);
  configured.groups[0].selection = selection; configured.groups[0].properties = {};
  const holder = spawn(process.env.PYTHON_BIN || 'python', ['-u', '-c',
    'import sqlite3,sys\nconnection=sqlite3.connect(sys.argv[1],timeout=5)\nconnection.execute("BEGIN IMMEDIATE")\nprint("locked",flush=True)\nsys.stdin.readline()\nconnection.rollback()\nconnection.close()', path.join(output, 'wallpaper.db')],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let locked = false, lockFailure = '', lockError;
  holder.stdout.on('data', bytes => { if (bytes.toString().includes('locked')) locked = true; });
  holder.stderr.on('data', bytes => { lockFailure += bytes.toString(); });
  holder.on('error', error => { lockError = error; });
  const requestId = 'owned-delete-' + crypto.randomUUID();
  let released = false;
  try {
    await until(() => { if (lockError) throw lockError; if (holder.exitCode !== null) throw new Error(lockFailure || 'lock holder exited'); return locked; }, 'isolated database write lock');
    await settings.evaluate(({ requestId, remove }) => {
      window.__referenceDelete = null;
      hertzWallpaperSettings.requestManagement('wallpaper.library.deleteVersion', remove, requestId)
        .then(receipt => { window.__referenceDelete = receipt; }, error => { window.__referenceDelete = error.receipt || { error: { code: error.code, message: error.message } }; });
    }, { requestId, remove });
    await until(() => !fs.existsSync(original), 'owned delete reaches blocked database commit', 3000);
    const envelope = (command, payload, requestId) => ({ protocol: 2, command, payload, requestId });
    for (let repeat = 0; repeat < 2; repeat++) {
      const duplicate = await native(envelope('wallpaper.library.deleteVersion', remove, requestId));
      assert.equal(duplicate.error.code, 'conflict', 'rejected same-ID duplicate must not clear original deletion admission');
    }
    const update = await api('wallpaper.draft.update', { ...ref(draft), operations: [{ kind: 'replaceWallpaper', wallpaper: configured }] });
    assert.equal(update.error.code, 'conflict', 'pending deletion blocks new native draft references');
    await settings.evaluate(() => {
      window.__referenceWrites = [];
      for (let index = 0; index < 3; index++) {
        hertzWallpaperSettings.requestManagement('wallpaper.draft.create', { kind: 'work', document: { title: '占用请求槽 ' + index, sceneId: 'coast', stateVersion: 1, params: {} } })
          .then(receipt => window.__referenceWrites.push(receipt), error => window.__referenceWrites.push(error.receipt || { error: { code: error.code } }));
      }
    });
    const saturated = await until(async () => {
      const receipt = await native(envelope('wallpaper.library.references', query, requestId));
      return receipt.error?.code === 'budget_busy' && receipt;
    }, 'all four native service slots occupied', 1800);
    assert.equal(saturated.error.code, 'budget_busy');
    const stillPending = await native(envelope('wallpaper.library.deleteVersion', remove, requestId));
    assert.equal(stillPending.error.code, 'conflict', 'other-command same-ID admission failure must not clear delete guard');
    holder.stdin.end('\n'); released = true;
    await settings.waitForFunction(() => window.__referenceDelete !== null && window.__referenceWrites.length === 3, null, { timeout: 10000 });
    const result = await settings.evaluate(() => ({ deleted: __referenceDelete, writes: __referenceWrites }));
    assert.equal(result.deleted.ok, true, JSON.stringify(result.deleted));
    assert.ok(result.writes.every(receipt => receipt.ok), JSON.stringify(result.writes));
    for (const receipt of result.writes) ok(await api('wallpaper.draft.discard', ref(receipt.result)));
    fs.writeFileSync(path.join(output, 'deletion-admission.json'), JSON.stringify({ refused, saturated, stillPending, completed: result.deleted }, null, 2));
  } finally {
    if (!released && holder.stdin.writable) holder.stdin.end('\n');
    if (holder.exitCode === null && holder.signalCode === null) {
      await until(() => holder.exitCode !== null || holder.signalCode !== null, 'owned database lock helper exit', 5000).catch(() => holder.kill());
    }
  }
  ok(await api('wallpaper.draft.discard', ref(draft)));
  assert.equal(fs.existsSync(original), false);
  assert.equal((await api('wallpaper.library.references', query)).error.code, 'work_not_found');
  checks.push('real blocked deletion keeps admission through duplicate same-ID responses and saturated other-command failure; original worker alone releases guard and deletes unreferenced content');
};
