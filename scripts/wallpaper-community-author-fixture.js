// SPDX-License-Identifier: MIT
// Isolated native-receipt fixture for the shipped community settings controllers.
// These receipts exercise browser behavior, not OIDC, HTTPS or native file access.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'crates/hertz-desktop/assets');
const sourceA = '11111111-1111-4111-8111-111111111111';
const sourceB = '33333333-3333-4333-8333-333333333333';
const workId = '22222222-2222-4222-8222-222222222222';
const publicWorkId = '66666666-6666-4666-8666-666666666666';
const publicReleaseId = '77777777-7777-4777-8777-777777777777';
const bytes = fs.readFileSync(path.join(root, 'crates/hertz-wallpaper-hub/tests/fixtures/author-upload.hwpk'));
const packageHash = createHash('sha256').update(bytes).digest('hex');
const title = '晨光 <img src=x onerror=alert(1)>';
const license = { code: 'none', assets: 'CC0-1.0', attribution: 'Fixture attribution' };
const initial = {
  revision: 9,
  config: { enabled: false, audioInput: { kind: 'hertz', gain: 1, attackMs: 40, releaseMs: 250 }, batteryPolicy: 'pause', pauseOnFullscreen: true, pauseOnMaximized: false, applicationRules: [], groups: [{ id: 'main', mode: 'single', displays: [{ kind: 'primary' }], selection: { kind: 'followHertz', idleBuiltin: { sceneId: 'zodiac', stateVersion: 1, params: {} } }, presentation: { fps: 30, quality: 'low', brightness: 1, motion: 1, fit: 'cover', pointer: false }, properties: {} }] },
  lyricsConfig: { enabled: false, locked: true, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32, fontWeight: 600, sungColor: '#8fe3ff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 2, opacity: .92, width: 900, anchorX: .5, anchorY: .84, monitor: null },
  scenes: [{ id: 'zodiac', label: '星空' }], profile: { dataDir: 'C:/IsolatedFixture', edition: 'full' },
  profiles: [{ dataDir: 'C:/IsolatedFixture', edition: 'full' }], monitors: [{ name: 'DISPLAY1', displayId: 'monitor-1', label: '主屏 · 1920×1080', primary: true }],
  spaceScene: 'zodiac', previewActive: false, launchAtLogin: false, positionEditing: false,
  runtime: { enabled: false, locked: true, visible: false, source: 'ok', userHidden: false, policy: { noContent: true }, wallpaper: { enabled: false, visible: false, hidden: false, fps: 30 }, diagnostics: { pauseReasons: ['disabled'] } }
};
function settingsHtml() {
  const read = name => fs.readFileSync(path.join(assets, name), 'utf8');
  const tokens = {
    __DISPLAYS_CSS__: read('wallpaper-displays.css'), __DISPLAYS__: read('wallpaper-displays.js'),
    __SETTINGS__: read('wallpaper-settings.js'), __LIBRARY__: read('wallpaper-library.js'),
    __COMMUNITY_CSS__: read('wallpaper-community.css'),
    __COMMUNITY_PANEL__: read('wallpaper-community.html').replace('__AUTHOR_PANEL__', () => read('wallpaper-community-author.html')),
    __COMMUNITY__: ['wallpaper-community-view.js', 'wallpaper-community-author.js', 'wallpaper-community.js'].map(read).join('\n')
  };
  const bridge = `<script>window.ipc={postMessage(text){let request;try{request=JSON.parse(text);}catch(_){return;}if(request.protocol!==2)return;fetch('/fixture-management',{method:'POST',headers:{'Content-Type':'application/json'},body:text}).then(response=>response.json()).then(receipt=>window.hertzWallpaperSettings.applyManagement(receipt));}};</script>`;
  const boot = `<script>window.addEventListener('DOMContentLoaded',()=>window.hertzWallpaperSettings.applyStatus(${JSON.stringify(initial).replace(/</g, '\\u003c')}));</script>`;
  return read('wallpaper-settings.html').replace(/__[A-Z_]+__/g, marker => tokens[marker] || '')
    .replace('<head>', '<head>' + bridge).replace('</body>', boot + '</body>');
}
function createFixture() {
  const requests = [], works = [], uploads = [], candidates = [], reports = [], operations = new Map(), held = [];
  const subjects = new Map([[sourceA, 'author-a'], [sourceB, 'author-b']]);
  const options = { unknownUpload: false, unknownCommand: null, deniedCommand: null, holdPrepare: false, queryFound: true, localPending: false };
  const now = () => Math.floor(Date.now() / 1000);
  const profiles = [sourceA, sourceB].map((sourceId, index) => ({ sourceId, origin: `https://community-${index + 1}.example`, hubId: sourceId, rootFingerprint: 'a'.repeat(64), auth: { issuer: `https://identity-${index + 1}.example`, clientId: 'native-fixture', audience: 'hub-fixture', scopes: ['openid', 'profile', 'wallpaper.read', 'wallpaper.write'], algorithms: ['RS256'] } }));
  const account = source => {
    const profile = profiles.find(item => item.sourceId === source), subject = subjects.get(source);
    return profile && subject ? { sourceId: source, issuer: profile.auth.issuer, subject, expiresAt: now() + 3600 } : null;
  };
  const belongs = (item, source) => item.sourceId === source && item.subject === subjects.get(source);
  const snapshot = () => ({ sources: profiles.map(profile => ({ profile, keyGeneration: 1, lastSync: now(), revocationsFresh: true, clockRollback: false })), accounts: profiles.map(profile => account(profile.sourceId)).filter(Boolean), subscriptions: [], updates: [] });
  const receipt = (request, result, error = null) => ({ protocol: 2, requestId: request.requestId, ok: !error, configRevision: 9, jobId: null, result: error ? null : result, error });
  const send = (response, data) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data)); };
  function result(request) {
    const name = request.command.split('.').pop(), data = request.payload, source = data.sourceId || sourceA;
    const profile = profiles.find(item => item.sourceId === source), current = account(source);
    if (name === 'status' && request.command.startsWith('wallpaper.community.')) return snapshot();
    if (name === 'authorLocal') return { items: [{ workKey: 'local:' + workId, title, version: 1, packageHash }], nextCursor: null };
    if (name === 'login') { subjects.set(source, source === sourceA ? 'author-a' : 'author-b'); return { account: account(source) }; }
    if (name === 'logout') { subjects.set(source, null); return { loggedOut: true, sourceId: source }; }
    if (name === 'authorInvalidate' || name === 'invalidate' || name === 'cancelLogin') return { invalidated: true };
    if (name === 'authorCancel') return { cancelRequested: true };
    if (name === 'browse') return { offset: 0, nextOffset: null, items: [{ id: publicWorkId, title: '已发布作品 <svg onload=alert(1)>', licenseJson: JSON.stringify(license) }] };
    if (name === 'authorPrepare') return { ticket: 'fixture-ticket-' + randomUUID(), expiresInSeconds: 300, review: { sourceId: source, sourceOrigin: profile.origin, subject: current.subject, workId, title, version: 1, kind: 'image', packageHash, bytes: bytes.length, license, permissions: { audioSpectrum: true, pointer: false } } };
    if (name === 'authorCreate') {
      const work = { id: workId, title, licenseJson: JSON.stringify(license), sourceId: source, subject: current.subject };
      works.push(work); operations.set(data.operationId, { kind: 'work', work }); return { work };
    }
    if (name === 'authorUpload') {
      const upload = data.uploadId ? uploads.find(item => item.id === data.uploadId && belongs(item, source)) : { id: randomUUID(), workId, packageHash, expectedBytes: bytes.length, minEngineProtocol: 1, state: 'ready', expiresAt: now() + 1800, releaseId: null, sourceId: source, subject: current.subject };
      if (!upload) throw new Error('Original fixture upload missing');
      upload.state = 'ready';
      if (!data.uploadId) { uploads.push(upload); operations.set(data.operationId, { kind: 'upload', upload }); }
      return { upload };
    }
    if (name === 'authorSubmit') {
      const upload = uploads.find(item => item.id === data.uploadId && belongs(item, source));
      if (!upload || upload.packageHash !== data.packageHash || !data.consent) throw new Error('Invalid fixture submit identity');
      const candidate = { id: randomUUID(), workId, packageHash, bytes: upload.expectedBytes, version: 1, title, kind: 'image', state: 'pending_review', sourceId: source, subject: current.subject };
      candidates.push(candidate); upload.state = 'submitted'; upload.releaseId = candidate.id; return { candidate };
    }
    if (name === 'authorList') return { works: works.filter(item => belongs(item, source)), candidates: candidates.filter(item => belongs(item, source)), uploads: uploads.filter(item => belongs(item, source) && ['ready', 'reserved', 'receiving', 'validating'].includes(item.state)), offset: data.offset || 0, nextOffset: null, subject: current.subject };
    if (name === 'authorOperation') {
      if (!options.queryFound) return { found: false, localPending: options.localPending };
      let saved = data.uploadId ? { kind: 'upload', upload: uploads.find(item => item.id === data.uploadId && belongs(item, source)) } : operations.get(data.operationId);
      if (!saved) return { found: false, localPending: options.localPending };
      const object = saved.work || saved.upload || saved.report;
      if (!object || !belongs(object, source)) return { found: false, localPending: options.localPending };
      const candidate = saved.upload && candidates.find(item => item.id === saved.upload.releaseId);
      return { found: true, work: saved.work, upload: saved.upload, report: saved.report, candidate, localPending: options.localPending };
    }
    if (name === 'reportPrepare') return { ticket: 'fixture-report-' + randomUUID(), expiresInSeconds: 300, review: { sourceId: source, sourceOrigin: profile.origin, subject: current.subject, workId: publicWorkId, releaseId: publicReleaseId, version: 7, packageHash: 'b'.repeat(64) } };
    if (name === 'reportSubmit') {
      const report = { id: randomUUID(), releaseId: publicReleaseId, reason: data.reason, description: data.description, status: 'open', resolution: null, sourceId: source, subject: current.subject };
      reports.push(report); operations.set(data.operationId, { kind: 'report', report }); return { submitted: true, reportId: report.id, releaseId: report.releaseId };
    }
    if (name === 'reportDetail') {
      const report = reports.find(item => item.id === data.reportId && belongs(item, source));
      if (!report) throw new Error('Fixture report missing');
      return { report: { ...report, status: 'dismissed', resolution: { reason: '已核查 <img src=x onerror=alert(1)>', resolvedAt: now() } } };
    }
    if (request.command === 'wallpaper.library.list') return { works: [], nextCursor: null };
    if (request.command === 'wallpaper.status') return { activeJob: null, capabilities: {} };
    return {};
  }
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(settingsHtml()); return;
    }
    let raw = ''; for await (const part of request) { raw += part; if (raw.length > 65536) { response.writeHead(413); response.end(); return; } }
    const data = JSON.parse(raw);
    if (request.url === '/fixture-control') {
      Object.assign(options, data);
      if (Object.hasOwn(data, 'subject')) subjects.set(data.sourceId || sourceA, data.subject);
      if (data.uploadState) uploads.forEach(item => { item.state = data.uploadState; });
      if (data.releasePrepare) held.splice(0).forEach(item => send(item.response, item.receipt));
      send(response, { requests, uploads, candidates, reports }); return;
    }
    requests.push(data);
    try {
      if (options.deniedCommand && data.command === 'wallpaper.community.' + options.deniedCommand) {
        send(response, receipt(data, null, { code: 'community_denied', message: 'Fixture explicitly denied this operation' })); return;
      }
      const value = result(data);
      if (data.command.endsWith('authorPrepare') && options.holdPrepare) { held.push({ response, receipt: receipt(data, value) }); return; }
      const unknown = data.command.endsWith('authorUpload') && options.unknownUpload
        || options.unknownCommand && data.command === 'wallpaper.community.' + options.unknownCommand;
      send(response, receipt(data, value, unknown ? { code: 'author_result_unknown', message: 'Fixture lost original upload receipt' } : null));
    } catch (error) { send(response, receipt(data, null, { code: 'fixture_error', message: error.message })); }
  });
  return { server, requests, works, uploads, candidates, reports, options, snapshot,
    async start() { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + server.address().port; },
    async close() { held.splice(0).forEach(item => item.response.end()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}
module.exports = { createFixture, sourceA, sourceB, workId, packageHash };
if (require.main === module) {
  const fixture = createFixture();
  fixture.start().then(url => console.log(JSON.stringify({ url, pid: process.pid })));
  process.once('SIGTERM', () => fixture.close().then(() => process.exit(0)));
  process.once('SIGINT', () => fixture.close().then(() => process.exit(0)));
}
