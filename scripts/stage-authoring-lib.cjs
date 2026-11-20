// SPDX-License-Identifier: MIT
// Offline data-only tooling. This is not an application registry or an OS sandbox.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION = 1;
const LIMITS = Object.freeze({ inputBytes: 32768, outputBytes: 4 * 1024 * 1024,
  prepareMs: 12000, renderMs: 90000, prepareHeapMiB: 128, renderHeapMiB: 256,
  frames: 90, sourceBytes: 4 * 1024 * 1024 });
const UI_FILES = Object.freeze(['stage-resource-budget.js', 'stage-resource-policy.js', 'stage-json-source.js',
  'creative-gl.js', 'creative-anime.js', 'backgrounds.js', 'handdrawn.js', 'creative-share-code.js',
  'creative-stage.js', 'creative-contract.js', 'creative-draft.js', 'creative-templates.js']);
const SOURCE_FILES = Object.freeze([...UI_FILES.map(name => 'plugin/ui/' + name), 'LICENSE',
  'crates/hertz-studio/src/ai/stage-contract/stage-contract.json',
  'scripts/stage-authoring.cjs', 'scripts/stage-authoring-lib.cjs',
  'scripts/stage-authoring-prepare.cjs', 'scripts/stage-authoring-render.cjs']);
const REVIEW_GATES = Object.freeze(['visual', 'license', 'physicalDevice', 'longRun', 'isolation', 'ownerIntegration']);
const LICENSES = Object.freeze(['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'CC0-1.0', 'CC-BY-4.0']);
function ensure(test, message) { if (!test) throw new Error(message); }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function digest(value) { return sha(canonical(value)); }
function exact(value, allowed, required = allowed, context = 'record') {
  ensure(object(value), context + ' must be an object');
  for (const key of Object.keys(value)) ensure(allowed.includes(key), context + ' rejects field: ' + key);
  for (const key of required) ensure(Object.hasOwn(value, key), context + ' requires field: ' + key);
}
function boundedJson(bytes, limit = LIMITS.inputBytes) {
  ensure(Buffer.byteLength(bytes) <= limit, 'JSON input exceeds byte limit');
  const value = JSON.parse(bytes);
  function visit(item, depth) {
    ensure(depth <= 10, 'JSON input exceeds depth limit');
    if (typeof item === 'number') ensure(Number.isFinite(item), 'non-finite input number');
    if (item && typeof item === 'object') for (const key of Object.keys(item)) {
      ensure(!['__proto__', 'constructor', 'prototype'].includes(key), 'dangerous JSON key');
      visit(item[key], depth + 1);
    }
  }
  visit(value, 0); return value;
}
function readJson(file, limit = LIMITS.inputBytes) {
  ensure(fs.lstatSync(file).isFile(), 'JSON input must be a regular file');
  ensure(fs.statSync(file).size <= limit, 'JSON input exceeds byte limit');
  return boundedJson(fs.readFileSync(file, 'utf8'), limit);
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
function plain(value, name, max = 240) {
  ensure(typeof value === 'string' && value.trim() && value.length <= max, 'invalid ' + name);
  ensure(!/[\x00-\x1f<>\\/]|(?:https?|file|data|javascript):|(?:void\s+main|#version|=>)/i.test(value), name + ' must be plain text, without code, URL or path');
  return value;
}
function validateInput(input, contract, templates) {
  exact(input, ['authoringVersion', 'id', 'version', 'title', 'description', 'templateId', 'templateVersion', 'provenance', 'artifact']);
  ensure(input.authoringVersion === VERSION, 'unsupported authoring version');
  ensure(typeof input.id === 'string' && /^[a-z][a-z0-9-]{2,47}$/.test(input.id), 'invalid candidate id');
  ensure(Number.isSafeInteger(input.version) && input.version > 0 && input.version < 100000, 'invalid candidate version');
  plain(input.title, 'title', 80); plain(input.description, 'description', 400);
  const template = templates.find(item => item.id === input.templateId);
  ensure(template && template.compatible && input.templateVersion === template.version, 'template version or compatibility mismatch');
  exact(input.provenance, ['creator', 'sourceRef', 'revision', 'license', 'attribution']);
  for (const key of ['creator', 'sourceRef', 'revision', 'attribution']) plain(input.provenance[key], 'provenance.' + key);
  ensure(LICENSES.includes(input.provenance.license), 'unrecognized or non-derivative license; manual license resolution required');
  exact(input.artifact, ['artifactVersion', 'mode', 'intent', 'schemaVersion', 'schemaHash', 'basePresetHash']);
  const a = input.artifact;
  ensure(a.artifactVersion === 1 && a.mode === 'create', 'unsupported draft version or mode');
  ensure(a.schemaVersion === contract.schemaVersion && a.schemaHash === contract.schemaHash, 'contract version or hash mismatch');
  exact(a.intent, ['version', 'scene', 'patch', 'director', 'hand']);
  ensure(a.intent.version === 1 && a.intent.scene === template.scene, 'intent scene must match the fixed template');
  ensure(a.basePresetHash === contract.basePresetHashes[a.intent.scene], 'canonical baseline hash mismatch');
  ensure(a.intent.director === false, 'authoring fixture supports director disabled only');
  exact(a.intent.hand, ['on']); ensure(a.intent.hand.on === false, 'authoring fixture supports no hand layer');
  ensure(object(a.intent.patch) && Object.keys(a.intent.patch).length <= 64, 'patch exceeds bounded parameter slots');
  const scene = contract.scenes.find(item => item.id === a.intent.scene);
  const params = contract.commonParams.concat(scene.params.map(item => ({ ...item, name: 'sc.' + item.name })));
  for (const [key, value] of Object.entries(a.intent.patch)) {
    const param = params.find(item => item.name === key);
    ensure(param && typeof value === 'number' && Number.isFinite(value), 'unknown or non-numeric parameter slot: ' + key);
    ensure(value >= param.min && value <= param.max, 'parameter outside canonical range: ' + key);
  }
  return input;
}
function fileHash(file) {
  ensure(fs.lstatSync(file).isFile(), 'pinned source must be a regular file: ' + file);
  return sha(fs.readFileSync(file));
}
function sourceHashes(root = ROOT) { return Object.fromEntries(SOURCE_FILES.map(file => [file, fileHash(path.join(root, file))])); }
function treeHash(root) {
  const rows = [];
  function visit(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, item.name);
      ensure(!item.isSymbolicLink(), 'toolchain symlink is not supported: ' + file);
      if (item.isDirectory()) visit(file);
      else if (item.isFile()) {
        ensure(rows.length < 12000, 'toolchain file count limit');
        rows.push([path.relative(root, file).split(path.sep).join('/'), fileHash(file)]);
      }
    }
  }
  visit(root); return { sha256: digest(rows), files: rows.length };
}
function toolchain(playwright, browser) {
  const pwRoot = fs.realpathSync(playwright), browserExe = fs.realpathSync(browser);
  ensure(path.basename(pwRoot) === 'playwright', 'pin the installed playwright package directory');
  const coreRoot = fs.realpathSync(path.join(pwRoot, '../playwright-core'));
  const browserRoot = path.dirname(browserExe);
  return { node: { path: process.execPath, version: process.version, sha256: fileHash(process.execPath) },
    playwright: { path: pwRoot, version: readJson(path.join(pwRoot, 'package.json')).version, ...treeHash(pwRoot) },
    playwrightCore: { path: coreRoot, version: readJson(path.join(coreRoot, 'package.json')).version, ...treeHash(coreRoot) },
    browser: { path: browserExe, root: browserRoot, ...treeHash(browserRoot) } };
}
function makeLock(playwright, browser) {
  return { lockVersion: VERSION, pipelineVersion: VERSION, sourceSha256: sourceHashes(),
    toolchain: toolchain(playwright, browser), limits: LIMITS,
    boundary: 'Fixed trusted sources; JSON-only untrusted input. Lock identity is not source approval or an OS isolation certificate.' };
}
function verifyLock(lock) {
  ensure(lock.lockVersion === VERSION && lock.pipelineVersion === VERSION, 'unsupported toolchain lock version');
  ensure(canonical(lock.limits) === canonical(LIMITS), 'work limits differ from pinned pipeline');
  ensure(canonical(lock.sourceSha256) === canonical(sourceHashes()), 'pinned source hash mismatch; review sources and explicitly re-pin');
  const current = toolchain(lock.toolchain.playwright.path, lock.toolchain.browser.path);
  ensure(canonical(current) === canonical(lock.toolchain), 'pinned toolchain version or hash mismatch');
  return true;
}
function cleanEnv(tempDir) {
  const env = { TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir, LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1' };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
function scrubProcessEnv(tempDir) {
  // Windows may add user/profile defaults when starting a process even when an
  // explicit env map was supplied. Remove them before any fixture or browser load.
  const clean = cleanEnv(tempDir);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, clean);
}
function within(parent, child) {
  const rel = path.relative(fs.realpathSync(parent), path.resolve(child));
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function removeScratch(parent, scratch) {
  ensure(within(parent, scratch) && !fs.lstatSync(scratch).isSymbolicLink(), 'scratch cleanup target is outside owned output');
  fs.rmSync(scratch, { recursive: true, force: true });
}
async function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') await new Promise(resolve => {
    const exe = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:/Windows', 'System32/taskkill.exe');
    const killer = spawn(exe, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', resolve); killer.on('close', resolve);
  });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
}
function runWorker(file, payload, options) {
  const args = ['--max-old-space-size=' + options.heapMiB];
  if (options.protoGuard !== false) args.push('--disable-proto=throw');
  if (options.permissionRead) args.push('--permission', '--allow-fs-read=' + options.permissionRead);
  args.push(file);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: options.cwd, env: cleanEnv(options.cwd),
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', reason = null, ending = false;
    const start = performance.now();
    const stop = async message => { if (ending) return; ending = true; reason = message; await terminateTree(child); };
    const timer = setTimeout(() => { void stop('worker wall-clock timeout'); }, options.timeoutMs);
    child.stdout.on('data', bytes => { stdout += bytes; if (Buffer.byteLength(stdout) > LIMITS.outputBytes) void stop('worker output limit'); });
    child.stderr.on('data', bytes => { if (stderr.length < 65536) stderr += bytes; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (reason || code !== 0) return reject(new Error(reason || 'worker failed (' + (signal || code) + '): ' + stderr.slice(-4000)));
      try { resolve({ value: boundedJson(stdout, LIMITS.outputBytes), elapsedMs: performance.now() - start }); }
      catch (error) { reject(new Error('worker returned invalid bounded JSON: ' + error.message)); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(payload));
  });
}
async function stdinJson() {
  let bytes = ''; for await (const part of process.stdin) {
    bytes += part; ensure(Buffer.byteLength(bytes) <= LIMITS.outputBytes, 'worker input limit');
  }
  return boundedJson(bytes, LIMITS.outputBytes);
}
module.exports = { ROOT, VERSION, LIMITS, UI_FILES, SOURCE_FILES, REVIEW_GATES, LICENSES, ensure,
  object, canonical, digest, sha, exact, readJson, writeJson, boundedJson, plain, validateInput,
  fileHash, sourceHashes, makeLock, verifyLock, cleanEnv, scrubProcessEnv, within, removeScratch, runWorker, stdinJson };
