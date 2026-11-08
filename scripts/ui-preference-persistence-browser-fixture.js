// SPDX-License-Identifier: MIT
// Dedicated HTTP CAS + production StagePersistence and Workshop source harness.
// The HTTP store models commit receipts, not the real service's disk storage.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '../plugin/ui', name), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function arrival(fixture, target) {
  let timer;
  try {
    await Promise.race([fixture.arrived[target].promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('late ' + target + ' HTTP PUT did not arrive')), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

function createStageApi() {
  const cases = new Map();
  function add(name) {
    const state = { current: { revision: 1, initialized: true }, library: { revision: 1, initialized: true }, storeId: 'browser-CAS-fixture' };
    const fixture = { snapshot: { state, current: { name: 'initial', bg: { type: 'theme' } }, library: [] },
      requests: [], hold: {}, failures: {}, held: {}, arrived: { current: deferred(), library: deferred() },
      release(target) { this.hold[target] = false; (this.held[target] || []).forEach(resolve => resolve()); this.held[target] = []; } };
    cases.set(name, fixture); return fixture;
  }
  function handle(request, response, url) {
    if (url.pathname !== '/v1/stage/presets') return false;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return true; }
    const fixture = cases.get(url.searchParams.get('fixture'));
    if (!fixture) { response.writeHead(404).end('{}'); return true; }
    (async () => {
      if (request.method === 'GET') {
        fixture.requests.push({ method: 'GET' }); response.end(JSON.stringify(fixture.snapshot)); return;
      }
      let text = ''; for await (const part of request) text += part;
      const body = JSON.parse(text), target = body.target;
      assert.ok(['current', 'library'].includes(target));
      fixture.requests.push({ method: 'PUT', body: clone(body) });
      if (fixture.hold[target]) {
        fixture.arrived[target].resolve();
        await new Promise(resolve => { (fixture.held[target] ||= []).push(resolve); });
      }
      if (fixture.failures[target] > 0) {
        fixture.failures[target]--; response.writeHead(503).end(JSON.stringify({ error: 'fixture late ' + target + ' PUT failure' })); return;
      }
      assert.equal(body.expectedPresetRevision, fixture.snapshot.state[target].revision, 'real owner sends the current CAS revision');
      const receipt = { revision: fixture.snapshot.state[target].revision + 1, requestId: body.requestId };
      fixture.snapshot[target] = clone(body.payload);
      fixture.snapshot.state[target] = { revision: receipt.revision, initialized: true, lastCommit: receipt };
      response.end(JSON.stringify(receipt));
    })().catch(error => { response.writeHead(500).end(JSON.stringify({ error: error.message })); });
    return true;
  }
  return { add, handle };
}

function between(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'production source anchor ' + start);
  return source.slice(first, last);
}
const creative = read('creative-stage.js');
const productionFlush = creative.match(/  function flushLocalSave\(\)[^\n]+/)[0];
const flushCurrent = creative.match(/    flushPersistence: function \(\) \{[^\n]+/)[0];
const flushLibrary = creative.match(/    flushLibrary: function \(\) \{[^\n]+/)[0];
const workshop = read('workshop.js');
const wrapper = between(workshop, '  var pendingMediaEdits = 0;', '\n  var tab =');
const pending = workshop.match(/hasPendingMediaEdits: function \(\) \{[^\n]+/)[0];
const select = between(workshop, '        use.onclick = mediaEdit(async function () {', '        var remove =');
const local = between(workshop, "      file.addEventListener('change', mediaEdit(async function () {", '      fileRow.appendChild(file);');
const recover = between(workshop, '      recover.onclick = mediaEdit(async function () {', '      recovery.append(');

async function installPersistence(frame, server, name) {
  const fixture = server.stage.add(name);
  await frame.addScriptTag({ url: server.base + '/assets/stage-persistence.js' });
  await frame.addScriptTag({ content: `(function () {
    let sequence = 0;
    window.StageMedia = { uid: () => 'browser-CAS-' + (++sequence) };
    const endpoint = ${JSON.stringify(server.base + '/v1/stage/presets?fixture=' + name)};
    async function request(method, body) {
      const response = await fetch(endpoint, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
    }
    window.VMusicTransport = { get: () => request('GET'), put: (_, body) => request('PUT', body) };
    var saveTimer = 0;
    ${productionFlush}
    var hydratePromise = StagePersistence.load(null, null);
    window.CreativeStage = { hydrated: () => hydratePromise,
      ${flushCurrent}
      ${flushLibrary}
    };
    window.fixture.realStageReady = hydratePromise;
  })();` });
  await frame.evaluate(() => fixture.realStageReady);
  return fixture;
}

async function installWorkshop(frame) {
  await frame.addScriptTag({ content: `(function () {
    ${wrapper}
    window.Workshop = { ${pending} };
    var mediaNotice = '', asset = { media: 'image', assetRef: 'fixture-asset', status: 'ready' };
    var use = document.createElement('button'), recover = document.createElement('button');
    var file = document.createElement('input'); file.type = 'file'; file.id = 'fixture-workshop-file'; file.hidden = true; document.body.appendChild(file);
    var progress = document.createElement('p'), cancelImport = document.createElement('button');
    var flash = text => { fixture.mediaMessages.push(text); }, render = () => {};
    var CS = { cancelPreview() {}, setBackground(value) { fixture.mediaBackground = value; }, flushPersistence: () => fixture.boundary('mediaFlush') };
    var Backgrounds = { commitSelection() { fixture.mediaCommits++; },
      async selectMedia() { await fixture.boundary('media-select'); return { type: 'media', assetRef: 'fixture-select' }; },
      async setLocalFile() { await fixture.boundary('media-local'); return { type: 'media', assetRef: 'fixture-local' }; },
      async recoverMedia() { await fixture.boundary('media-recover'); return { type: 'media', assetRef: 'fixture-recover' }; } };
    fixture.mediaMessages = []; fixture.mediaCommits = 0;
    ${select}
    ${local}
    ${recover}
    fixture.startMedia = name => {
      fixture.hold('media-' + name);
      if (name === 'select') fixture.mediaTask = use.onclick();
      else if (name === 'recover') fixture.mediaTask = recover.onclick();
    };
    fixture.wrapperThrows = () => mediaEdit(() => { throw new Error('wrapper synchronous failure'); })().catch(error => error.message);
  })();` });
}

async function checkLatePersistence(context, server, text, report, helpers) {
  const { dbxPage, ready, preview, idle, mark, noReload } = helpers;
  const late = await dbxPage(context, server, 'late-stage-owner'); await ready(late.frame);
  try {
    const api = await installPersistence(late.frame, server, 'late-stage-owner');
    const token = await mark(late.frame), loads = await late.page.evaluate(() => dbxFixture.loads);
    await preview(late.frame, text); await late.page.evaluate(() => { dbxFixture.hold.set = true; });
    await late.frame.locator('#ui-preferences-apply').click();
    await late.page.waitForFunction(() => dbxFixture.held.set?.length === 1);
    api.hold.current = api.hold.library = true;
    await late.frame.evaluate(() => {
      fixture.lateCurrent = StagePersistence.save('current', { name: 'late current', bg: { type: 'theme' } }).catch(error => { fixture.stageFailure = error.message; });
      fixture.lateLibrary = StagePersistence.save('library', [{ name: 'late library', bg: { type: 'theme' } }]).catch(error => { fixture.stageFailure = error.message; });
    });
    await Promise.all([arrival(api, 'current'), arrival(api, 'library')]);
    await late.page.evaluate(() => dbxFixture.release('set'));
    await late.frame.waitForFunction(() => document.getElementById('ui-preferences-dialog-status').textContent.includes('正在确认舞台'));
    await noReload(late.frame, token);
    assert.equal(await late.page.evaluate(() => dbxFixture.loads), loads, 'DBX ack does not reload while late real current/library PUTs are in flight');
    api.release('current'); await late.frame.evaluate(() => fixture.lateCurrent);
    await noReload(late.frame, token);
    assert.equal(await late.frame.evaluate(() => StagePersistence.status().library.saving), true);
    api.release('library'); await late.page.waitForFunction(old => dbxFixture.loads > old, loads); await ready(late.frame);
    assert.equal(api.snapshot.current.name, 'late current'); assert.equal(api.snapshot.library[0].name, 'late library');
    assert.equal(api.snapshot.state.current.revision, 2); assert.equal(api.snapshot.state.library.revision, 2);
    assert.equal(await late.page.evaluate(() => dbxFixture.requests.filter(item => item.method === 'set').length), 1);
    report.lateStageRequests = [{ name: 'current/library acknowledgement', requests: clone(api.requests) }];
  } finally { await late.page.close(); }

  const failed = await dbxPage(context, server, 'late-stage-failure'); await ready(failed.frame);
  try {
    const api = await installPersistence(failed.frame, server, 'late-stage-failure');
    const token = await mark(failed.frame), loads = await failed.page.evaluate(() => dbxFixture.loads);
    await preview(failed.frame, text); await failed.page.evaluate(() => { dbxFixture.hold.set = true; });
    await failed.frame.locator('#ui-preferences-apply').click(); await failed.page.waitForFunction(() => dbxFixture.held.set?.length === 1);
    api.hold.library = true; api.failures.library = 1;
    await failed.frame.evaluate(() => { fixture.lateLibrary = StagePersistence.save('library', [{ name: 'retry late library' }]).catch(error => { fixture.stageFailure = error.message; }); });
    await arrival(api, 'library');
    await failed.page.evaluate(() => dbxFixture.release('set')); api.release('library'); await idle(failed.frame);
    assert.match(await failed.frame.locator('#ui-preferences-dialog-status').innerText(), /偏好已保存，暂不重新加载.*late library PUT failure/);
    assert.equal(await failed.frame.locator('#ui-preferences-apply').innerText(), '保存舞台并重新加载');
    assert.equal(await failed.frame.locator('#ui-preferences-cancel').innerText(), '返回播放器');
    await noReload(failed.frame, token);
    assert.equal(await failed.page.evaluate(() => dbxFixture.requests.filter(item => item.method === 'set').length), 1);
    await failed.frame.evaluate(() => StagePersistence.retry());
    await failed.frame.locator('#ui-preferences-apply').click();
    await failed.page.waitForFunction(old => dbxFixture.loads > old, loads); await ready(failed.frame);
    assert.equal(await failed.page.evaluate(() => dbxFixture.requests.filter(item => item.method === 'set').length), 1, 'saved=true retry never repeats the preference batch');
    assert.equal(api.snapshot.library[0].name, 'retry late library');
    report.lateStageRequests.push({ name: 'failed library receipt/read/retry', requests: clone(api.requests) });
  } finally { await failed.page.close(); }
  report.checks.push('real StagePersistence + CreativeStage production flush source: late HTTP current/library CAS PUTs drain after DBX ack; failed post-save flush retries without a second preference batch');
}

async function checkWorkshop(context, server, text, report, helpers) {
  const { dbxPage, ready, preview, idle, mark, noReload, storage } = helpers;
  for (const name of ['select', 'local', 'recover']) for (const failedTask of [false, true]) {
    const test = await dbxPage(context, server, 'workshop-' + name + '-' + failedTask); await ready(test.frame);
    try {
      await installWorkshop(test.frame);
      const before = await storage(test.frame), token = await mark(test.frame);
      if (name === 'local') {
        await test.frame.evaluate(() => fixture.hold('media-local'));
        await test.frame.locator('#fixture-workshop-file').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('controlled media boundary') });
      } else await test.frame.evaluate(name => fixture.startMedia(name), name);
      assert.equal(await test.frame.evaluate(() => Workshop.hasPendingMediaEdits()), true, name + ' begins pending');
      await preview(test.frame, text); await test.frame.locator('#ui-preferences-apply').click(); await idle(test.frame);
      assert.match(await test.frame.locator('#ui-preferences-dialog-status').innerText(), /工坊仍在处理背景素材/);
      assert.deepEqual(await storage(test.frame), before); await noReload(test.frame, token);
      assert.equal(await test.page.evaluate(() => dbxFixture.requests.filter(item => item.method === 'set').length), 0);
      if (!failedTask) await test.frame.evaluate(() => fixture.hold('mediaFlush'));
      await test.frame.evaluate(({ name, failedTask }) => fixture.release('media-' + name, failedTask ? 'media boundary failure' : null), { name, failedTask });
      if (!failedTask) {
        await test.frame.waitForFunction(() => fixture.stageLog.includes('mediaFlush'));
        assert.equal(await test.frame.evaluate(() => Workshop.hasPendingMediaEdits()), true, 'the actual handler remains pending until background persistence finishes');
        await test.frame.evaluate(() => fixture.release('mediaFlush'));
      }
      await test.frame.waitForFunction(() => !Workshop.hasPendingMediaEdits());
      if (failedTask) assert.ok((await test.frame.evaluate(() => fixture.mediaMessages)).some(message => message.includes('media boundary failure')), name + ' catch completes pending count');
      else assert.equal(await test.frame.evaluate(() => fixture.mediaBackground.assetRef), 'fixture-' + name);
      assert.equal(await test.frame.evaluate(() => fixture.wrapperThrows()), 'wrapper synchronous failure');
      assert.equal(await test.frame.evaluate(() => Workshop.hasPendingMediaEdits()), false, 'sync throw finally decrements the actual wrapper count');
      const loads = await test.page.evaluate(() => dbxFixture.loads);
      await test.frame.locator('#ui-preferences-apply').click(); await test.page.waitForFunction(old => dbxFixture.loads > old, loads); await ready(test.frame);
      assert.equal(await test.page.evaluate(() => dbxFixture.requests.filter(item => item.method === 'set').length), 1, 'completed/caught media edit allows one retry batch');
    } finally { await test.page.close(); }
  }
  const during = await dbxPage(context, server, 'workshop-during-stage-flush'); await ready(during.frame);
  try {
    await installWorkshop(during.frame);
    const before = await storage(during.frame), token = await mark(during.frame);
    await during.frame.evaluate(() => fixture.hold('current'));
    await preview(during.frame, text); await during.frame.locator('#ui-preferences-apply').click();
    await during.frame.waitForFunction(() => fixture.stageLog.includes('current'));
    await during.frame.evaluate(() => { fixture.startMedia('select'); fixture.release('current'); }); await idle(during.frame);
    assert.match(await during.frame.locator('#ui-preferences-dialog-status').innerText(), /工坊仍在处理背景素材/);
    assert.deepEqual(await storage(during.frame), before); await noReload(during.frame, token);
    assert.equal(await during.page.evaluate(() => dbxFixture.requests.filter(item => item.method === 'set').length), 0, 'media that begins during initial stage flush is caught by the trailing media check');
    await during.frame.evaluate(() => fixture.release('media-select')); await during.frame.waitForFunction(() => !Workshop.hasPendingMediaEdits());
  } finally { await during.page.close(); }
  const late = await dbxPage(context, server, 'workshop-during-dbx-write'); await ready(late.frame);
  try {
    await installWorkshop(late.frame);
    const token = await mark(late.frame), loads = await late.page.evaluate(() => dbxFixture.loads);
    await preview(late.frame, text); await late.page.evaluate(() => { dbxFixture.hold.set = true; });
    await late.frame.locator('#ui-preferences-apply').click(); await late.page.waitForFunction(() => dbxFixture.held.set?.length === 1);
    await late.frame.evaluate(() => fixture.startMedia('select'));
    await late.page.evaluate(() => dbxFixture.release('set')); await idle(late.frame);
    assert.match(await late.frame.locator('#ui-preferences-dialog-status').innerText(), /偏好已保存，暂不重新加载.*工坊仍在处理背景素材/);
    await noReload(late.frame, token);
    assert.equal(await late.frame.locator('#ui-preferences-apply').innerText(), '保存舞台并重新加载');
    assert.equal(await late.page.evaluate(() => dbxFixture.requests.filter(item => item.method === 'set').length), 1);
    await late.frame.evaluate(() => fixture.release('media-select')); await late.frame.waitForFunction(() => !Workshop.hasPendingMediaEdits());
    await late.frame.locator('#ui-preferences-apply').click(); await late.page.waitForFunction(old => dbxFixture.loads > old, loads); await ready(late.frame);
    assert.equal(await late.page.evaluate(() => dbxFixture.requests.filter(item => item.method === 'set').length), 1,
      'media that completes after preference persistence permits saved=true retry without another batch');
  } finally { await late.page.close(); }
  report.checks.push('actual Workshop mediaEdit wrapper and all 3 production handlers: async begin/end/catch/sync-throw; pending blocks writes/reload before and after stage flush, completion permits retry');
}

module.exports = { createStageApi, checkLatePersistence, checkWorkshop };
