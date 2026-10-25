'use strict';

const GPU_FIELDS = ['geometries', 'textures', 'programs'];
const SAMPLE_INTERVAL_MS = 60000;
const MAX_GAP_MS = 120000;
const AUXILIARY_TAGS = new Set(['frame', 'paused', 'resumed']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isTime = value => Number.isFinite(value) && value >= 0;

function parseLog(text) {
  const records = [], complete = [], done = [], receipts = [], failures = [];
  if (typeof text !== 'string') {
    failures.push({ code: 'INPUT', message: 'Expected probe.log text.' });
    return { records, complete, done, receipts, failures };
  }
  for (const [index, original] of text.split(/\r?\n/).entries()) {
    const line = index + 1;
    const text = original.trim();
    const probeError = /\bscene_[\w-]*error\b|\bscene_mount_failed\b|\brecovery_terminal\b|\bscene_finish_timeout\b/.test(text)
      || /^eval\b.*\berror\b/.test(text);
    if (probeError) {
      failures.push({ code: 'PROBE_ERROR', line, message: text.slice(0, 240) });
    }
    if (/^scene_complete(?:\s|$)/.test(text)) complete.push(line);
    if (/^state\s+.*\btag=done(?:\s|$)/.test(text)) done.push(line);
    if (!/^scene_js(?:\s|$)/.test(text)) continue;
    const raw = text.slice('scene_js'.length).trim();
    // This is the only non-JSON scene IPC receipt emitted by sceneFinish().
    if (raw === 'scene_done') { receipts.push(line); continue; }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      failures.push({ code: 'JSON', line, message: `Invalid scene_js JSON: ${error.message}` });
      continue;
    }
    if (!isObject(data) || typeof data.kind !== 'string' || !data.kind) {
      failures.push({ code: 'SCHEMA', line, message: 'scene_js must contain an object with a kind.' });
      continue;
    }
    if (!probeError && /^scene_.*error$|^scene_mount_failed$/.test(data.kind)) {
      failures.push({ code: 'PROBE_ERROR', line, message: `Scene IPC error: ${data.kind}` });
    }
    records.push({ line, raw, data });
  }
  return { records, complete, done, receipts, failures };
}

// doneMarker is external evidence; the pure verifier never reads files.
function analyze(text, options = {}) {
  const parsed = parseLog(text);
  const failures = [...parsed.failures];
  const fail = (code, message, line) => failures.push({ code, ...(line ? { line } : {}), message });
  const mode = options?.mode ?? 'context';
  const minimumMs = mode === 'soak' ? options?.minimumMs : null;
  if (!['context', 'soak'].includes(mode)
      || (mode === 'soak' && (!isCount(minimumMs) || minimumMs === 0))) {
    fail('OPTIONS', 'Use context, or soak with a positive integer minimumMs.');
  }

  const scenes = parsed.records.filter(record => record.data.kind === 'scene');
  const expected = ['mounted', 'baseline'];
  if (mode === 'context') {
    for (let cycle = 0; cycle < 3; cycle++) {
      expected.push('before-loss', 'context-lost', 'context-restored', 'after-restore');
    }
  }
  expected.push('final', 'before_unmount', 'unmounted');
  const lifecycle = scenes.filter(record => !AUXILIARY_TAGS.has(record.data.tag));
  if (lifecycle.length !== expected.length
      || lifecycle.some((record, i) => record.data.tag !== expected[i])) {
    fail('ORDER', `Expected lifecycle: ${expected.join(' -> ')}; got: ${lifecycle.map(record => record.data.tag).join(' -> ')}.`);
  }

  // Reject malformed important evidence, but keep analyzing other lines for diagnostics.
  const valid = [];
  for (const record of scenes) {
    const { data: s, line } = record;
    const bad = [];
    if (typeof s.tag !== 'string' || !s.tag) bad.push('tag');
    for (const key of ['frames', 'renderDraws', 'elapsedMs', 'timestamp', 'sceneTime', 'lossCount', 'restoreCount']) {
      if (!isCount(s[key])) bad.push(key);
    }
    for (const key of ['mounted', 'enabled', 'lost']) {
      if (typeof s[key] !== 'boolean') bad.push(key);
    }
    if (s.tag === 'unmounted') {
      if (s.stats !== null || s.mounted !== false) {
        fail('UNMOUNT', 'unmounted must acknowledge mounted=false and stats=null.', line);
      }
    } else if (!isObject(s.stats)) {
      bad.push('stats');
    } else {
      for (const key of [...GPU_FIELDS, 'drawCalls']) {
        if (!isCount(s.stats[key])) bad.push(`stats.${key}`);
      }
      if (!isTime(s.stats.time)) bad.push('stats.time');
      for (const key of ['playing', 'warmed']) {
        if (typeof s.stats[key] !== 'boolean') bad.push(`stats.${key}`);
      }
    }
    if (bad.length) fail('SCHEMA', `Invalid or missing ${bad.join(', ')}.`, line);
    else valid.push(record);
  }

  const get = tag => valid.find(record => record.data.tag === tag);
  const mounted = get('mounted'), baseline = get('baseline'), final = get('final'), unmounted = get('unmounted');
  for (const record of scenes) {
    if (AUXILIARY_TAGS.has(record.data.tag)
        && (!mounted || !final || record.line <= mounted.line || record.line >= final.line)) {
      fail('ORDER', `${record.data.tag} is outside the mounted -> final interval.`, record.line);
    }
  }
  if (!unmounted || parsed.complete.length !== 1 || parsed.done.length !== 1
      || parsed.complete[0] <= unmounted.line || parsed.done[0] <= parsed.complete[0]) {
    fail('TERMINATION', 'Require unmounted -> native scene_complete -> state tag=done exactly once.');
  }
  if (parsed.receipts.length > 1 || (parsed.receipts.length === 1
      && (!unmounted || parsed.receipts[0] <= unmounted.line || parsed.receipts[0] >= parsed.complete[0]))) {
    fail('TERMINATION', 'scene_done receipt is out of order.');
  }
  if (options?.doneMarker !== true) fail('DONE_MARKER', 'Missing external done.ready marker evidence.');
  if (baseline && (!baseline.data.enabled || baseline.data.lost)) {
    fail('STATE', 'Baseline must be active with a live context.', baseline.line);
  }
  if (baseline && !baseline.data.stats.warmed) fail('WARMUP', 'Baseline must be warmed.', baseline.line);

  const resourceBaseline = baseline ? Object.fromEntries(GPU_FIELDS.map(key => [key, baseline.data.stats[key]])) : null;
  const resourceRanges = Object.fromEntries(GPU_FIELDS.map(key => [key, { min: null, max: null }]));
  let lossCount = 0, restoreCount = 0, restored = null, previous = null;
  let soakReference = null, activeSinceSample = 0;
  const progress = (before, after) => after.frames > before.frames && after.sceneTime > before.sceneTime
    && after.renderDraws > before.renderDraws
    && after.stats && before.stats && after.stats.time > before.stats.time;
  for (const record of valid) {
    const { data: s, line } = record;
    if (s.tag === 'context-lost') lossCount++;
    if (s.tag === 'context-restored') restoreCount++;
    if (s.lossCount !== lossCount || s.restoreCount !== restoreCount
        || (mode === 'soak' && (s.lossCount !== 0 || s.restoreCount !== 0))) {
      fail('COUNTERS', `Expected lossCount=${lossCount}, restoreCount=${restoreCount}.`, line);
    }
    if (s.mounted !== (s.tag !== 'unmounted') || s.lost !== (lossCount > restoreCount)
        || (s.tag === 'paused' && s.enabled) || (s.tag === 'resumed' && !s.enabled)
        || (s.stats && (!s.enabled || s.lost) && s.stats.playing !== false)) {
      fail('STATE', 'Inconsistent mounted/enabled/lost/playing state.', line);
    }
    if (previous) {
      const p = previous.data;
      if (s.elapsedMs < p.elapsedMs || s.timestamp < p.timestamp) {
        fail('TIME_ORDER', 'elapsedMs and timestamp must not go backwards.', line);
      }
      if (s.frames < p.frames || s.sceneTime < p.sceneTime || s.renderDraws < p.renderDraws
          || (s.stats && p.stats && s.stats.time < p.stats.time)) {
        fail('PROGRESS', 'Frame or scene/renderer time counter regressed (possible rebuild).', line);
      }
      if ((p.lost || !p.enabled || p.tag === 'final' || p.tag === 'before_unmount')
          && (s.frames !== p.frames || s.sceneTime !== p.sceneTime || s.renderDraws !== p.renderDraws
            || (s.stats && p.stats && s.stats.time !== p.stats.time))) {
        fail('FROZEN', 'Frames and scene/renderer time must stay frozen during loss, pause, or teardown.', line);
      }
      if (soakReference && p.enabled && !p.lost) {
        activeSinceSample += Math.max(0, s.elapsedMs - p.elapsedMs);
      }
    }
    if (mode === 'soak' && baseline && line >= baseline.line && ['baseline', 'frame', 'final'].includes(s.tag)) {
      // Policy events may share a frame; compare successive samples instead.
      if (soakReference && s.enabled && !s.lost && activeSinceSample >= 100 && !progress(soakReference, s)) {
        fail('PROGRESS', 'Active soak samples must advance frames, sceneTime and stats.time.', line);
      }
      soakReference = s;
      activeSinceSample = 0;
    }
    if (s.tag === 'context-restored') restored = s;
    if (s.tag === 'after-restore' && (!restored || !progress(restored, s))) {
      fail('PROGRESS', 'after-restore must advance frames and scene/renderer time from context-restored.', line);
    }

    const awaitingRestoreDraw = mode === 'context' && restored && s.renderDraws === restored.renderDraws
      && ['context-restored', 'frame'].includes(s.tag);
    const afterBaseline = baseline && line >= baseline.line && (!final || line <= final.line);
    if (s.stats && afterBaseline) {
      for (const key of GPU_FIELDS) {
        const range = resourceRanges[key];
        range.min = range.min === null ? s.stats[key] : Math.min(range.min, s.stats[key]);
        range.max = range.max === null ? s.stats[key] : Math.max(range.max, s.stats[key]);
        if (s.enabled && !s.lost) {
          if (!awaitingRestoreDraw && s.stats[key] <= 0) fail('RESOURCE_EMPTY', `${s.tag}: ${key} must be positive.`, line);
          // Restoration progressively uploads GPU data; equality with baseline is not required.
          if (s.stats[key] > resourceBaseline[key]) {
            fail('RESOURCE_GROWTH', `${s.tag}: ${key}=${s.stats[key]} exceeds baseline ${resourceBaseline[key]}.`, line);
          }
        }
      }
      if (s.enabled && !s.lost) {
        // drawCalls is the last rendered frame's call count, NOT a cumulative counter.
        if (!awaitingRestoreDraw && s.stats.drawCalls <= 0) fail('DRAWS', `${s.tag}: drawCalls must be positive.`, line);
        if (!s.stats.playing) fail('STATE', `${s.tag}: active renderer must be playing.`, line);
        if (mode === 'soak' && s.tag === 'frame' && !s.stats.warmed) {
          fail('WARMUP', 'Active soak frames must remain warmed.', line);
        }
      }
    }
    const contextCapture = mode === 'context' && ['baseline', 'before-loss', 'after-restore', 'final'].includes(s.tag);
    if (contextCapture && (!s.enabled || s.lost)) {
      fail('STATE', `${s.tag}: context verification requires an active capture.`, line);
    }
    const needsPixels = contextCapture || s.tag === 'baseline'
      || (mode === 'soak' && s.enabled && !s.lost && ['frame', 'final'].includes(s.tag));
    if (needsPixels || s.pixels != null) {
      const p = s.pixels;
      if (!isObject(p) || !isCount(p.bright) || p.bright === 0
          || !isCount(p.width) || p.width === 0 || !isCount(p.height) || p.height === 0
          || !isCount(p.hash) || p.hash > 0xffffffff || p.error !== 0 || p.lost !== false) {
        fail('PIXELS', `${s.tag}: require nonblack capture, valid dimensions/hash, error=0 and lost=false.`, line);
      }
    }
    previous = record;
  }

  let elapsedMs = null, wallElapsedMs = null, activeMs = 0, pausedMs = 0, unobservedMs = 0, maximumGapMs = 0;
  if (mounted && final && final.line > mounted.line) {
    elapsedMs = final.data.elapsedMs - mounted.data.elapsedMs;
    wallElapsedMs = final.data.timestamp - mounted.data.timestamp;
    const window = valid.filter(record => record.line >= mounted.line && record.line <= final.line);
    const gaps = new Map();
    const inspectGap = (a, b) => {
      const gap = Math.max(b.data.elapsedMs - a.data.elapsedMs, b.data.timestamp - a.data.timestamp);
      maximumGapMs = Math.max(maximumGapMs, gap);
      if (mode === 'soak' && gap > MAX_GAP_MS) {
        const key = `${a.line}:${b.line}`;
        if (!gaps.has(key)) {
          gaps.set(key, [a.line, b.line]);
          fail('GAP', `Incomplete sampling: ${gap}ms gap from line ${a.line} exceeds ${MAX_GAP_MS}ms.`, b.line);
        }
      }
    };
    for (let i = 1; i < window.length; i++) inspectGap(window[i - 1], window[i]);
    // Policy/resume messages must not conceal a missing 60s frame heartbeat.
    if (mode === 'soak') {
      const heartbeat = window.filter(record => ['mounted', 'baseline', 'frame', 'final'].includes(record.data.tag));
      for (let i = 1; i < heartbeat.length; i++) inspectGap(heartbeat[i - 1], heartbeat[i]);
    }
    for (let i = 1; i < window.length; i++) {
      const a = window[i - 1], b = window[i];
      const delta = Math.max(0, b.data.elapsedMs - a.data.elapsedMs);
      if ([...gaps.values()].some(([start, end]) => start <= a.line && end >= b.line)) unobservedMs += delta;
      else if (a.data.enabled && !a.data.lost) activeMs += delta;
      else pausedMs += delta;
    }
  }
  if (mode === 'soak' && (elapsedMs === null || elapsedMs < minimumMs)) {
    fail('DURATION', `mounted -> final elapsedMs=${elapsedMs}; require at least ${minimumMs}ms.`);
  }
  return {
    status: failures.length ? 'fail' : 'pass', mode, failures,
    minimumMs: minimumMs ?? null, elapsedMs, wallElapsedMs, activeMs, pausedMs, unobservedMs,
    durationBasis: 'first mounted -> final elapsedMs (including warmup)',
    activityBasis: 'Sampled enabled && !lost wall-time estimates, not proof of continuous rendering or an active-duration soak; gaps are unobserved.',
    sampleIntervalMs: mode === 'soak' ? SAMPLE_INTERVAL_MS : null,
    maximumGapMs, maxAllowedGapMs: mode === 'soak' ? MAX_GAP_MS : null,
    resourceBaseline, resourceRanges,
  };
}

function main(argv) {
  const fs = require('node:fs');
  const path = require('node:path');
  const usage = 'Usage: node parse-scene.js <probe.log> [--verify-context | --verify-soak <minimum-ms>]';
  let file, mode, minimumMs;
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--verify-context' || arg === '--verify-soak') {
        if (mode) throw new Error(usage);
        mode = arg === '--verify-context' ? 'context' : 'soak';
        if (mode === 'soak') {
          const value = argv[++i];
          minimumMs = Number(value);
          if (!/^\d+$/.test(value || '') || !isCount(minimumMs) || minimumMs === 0) throw new Error(usage);
        }
      } else if (arg.startsWith('--') || file) throw new Error(usage);
      else file = arg;
    }
    if (!file) throw new Error(usage);
  } catch (error) {
    console.log(JSON.stringify({ status: 'fail', failures: [{ code: 'OPTIONS', message: error.message }] }));
    process.exitCode = 2;
    return;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    console.log(JSON.stringify({ status: 'fail', failures: [{ code: 'INPUT', message: error.message }] }));
    process.exitCode = 2;
    return;
  }
  if (mode) {
    let doneMarker = false;
    try { doneMarker = fs.statSync(path.join(path.dirname(file), 'done.ready')).isFile(); } catch (_) { /* Missing evidence fails verification. */ }
    const result = analyze(text, { mode, minimumMs, doneMarker });
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'pass' ? 0 : 1;
    return;
  }
  const parsed = parseLog(text);
  for (const { data, raw } of parsed.records) {
    if (data.kind !== 'scene') { console.log(`scene_js ${raw}`.slice(0, 160)); continue; }
    const s = data.stats || {};
    console.log(`${data.tag} mounted=${data.mounted} frames=${data.frames} playing=${s.playing} warmed=${s.warmed} geo=${s.geometries} tex=${s.textures} prog=${s.programs} res=${s.resources} bytes=${s.estimatedBytes} draws=${s.drawCalls} sign=${s.sign}`);
  }
  if (parsed.failures.length) {
    console.error(JSON.stringify({ status: 'fail', failures: parsed.failures }));
    process.exitCode = 1;
  }
}

module.exports = { analyze };
if (require.main === module) main(process.argv.slice(2));
