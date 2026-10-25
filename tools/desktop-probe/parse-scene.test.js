'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const parser = path.join(__dirname, 'parse-scene.js');

test('import exports analyze without reading files or running the CLI', () => {
  const result = spawnSync(process.execPath, ['-e',
    'const { analyze } = require(process.argv[1]); if (typeof analyze !== "function") process.exit(4);',
    parser], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

// Synthetic protocol fixtures, not measurements from a desktop/GPU run.
const gpu = { geometries: 118, textures: 12, programs: 6 };
const goodPixels = { bright: 42, hash: 123456, width: 640, height: 360, error: 0, lost: false };
function scene(tag, elapsedMs, sceneTime = elapsedMs - 1000, extra = {}) {
  const { stats, ...fields } = extra;
  return {
    kind: 'scene', tag, mounted: true, frames: Math.floor(sceneTime * 0.03), renderDraws: Math.floor(sceneTime * 0.03) * 20,
    elapsedMs, timestamp: 1800000000000 + elapsedMs, enabled: true, sceneTime,
    lost: false, lossCount: 0, restoreCount: 0, pixels: null,
    ...fields,
    stats: stats === null ? null : {
      ...gpu, playing: fields.enabled !== false && !fields.lost, warmed: tag !== 'mounted',
      drawCalls: 32, time: sceneTime / 1000, ...stats,
    },
  };
}
function ending(final) {
  return [final, { ...final, tag: 'before_unmount', pixels: null },
    { ...final, tag: 'unmounted', mounted: false, stats: null, pixels: null,
      elapsedMs: final.elapsedMs + 1, timestamp: final.timestamp + 1 },
    'scene_js scene_done', 'scene_complete', 'state tag=done alive=true'];
}
function contextLog() {
  const rows = [scene('mounted', 1000), scene('resumed', 1000),
    scene('baseline', 6000, 5000, { pixels: { ...goodPixels } }), scene('frame', 7000)];
  for (let cycle = 0; cycle < 3; cycle++) {
    const at = 8000 + cycle * 8000;
    const time = at - 1000 - cycle * 2000;
    const counts = { lossCount: cycle, restoreCount: cycle };
    rows.push(scene('before-loss', at, time, { ...counts, pixels: { ...goodPixels } }));
    counts.lossCount++;
    const lost = { ...counts, lost: true,
      stats: { geometries: 0, textures: 0, programs: 0, drawCalls: 0 } };
    rows.push(scene('context-lost', at, time, lost), scene('frame', at + 1000, time, lost));
    counts.restoreCount++;
    rows.push(scene('context-restored', at + 2000, time, {
      ...counts, stats: { geometries: 0, textures: 0, programs: 0, drawCalls: 0 },
    }));
    rows.push(scene('frame', at + 3000, time + 1000, {
      ...counts, stats: { geometries: 12, textures: 4, programs: 2 },
    }));
    rows.push(scene('after-restore', at + 6000, time + 4000, {
      ...counts, pixels: { ...goodPixels }, stats: { geometries: 80, textures: 10, programs: 4 },
    }));
  }
  return rows.concat(ending(scene('final', 33000, 26000, {
    lossCount: 3, restoreCount: 3, pixels: { ...goodPixels },
  })));
}
function soakLog(duration = 185000) {
  const rows = [scene('mounted', 1000), scene('resumed', 1000),
    scene('baseline', 6000, 5000, { pixels: { ...goodPixels } })];
  for (let elapsed = 61000; elapsed < duration + 1000; elapsed += 60000) {
    rows.push(scene('frame', elapsed, elapsed - 1000, { pixels: { ...goodPixels } }));
  }
  return rows.concat(ending(scene('final', duration + 1000, duration, { pixels: { ...goodPixels } })));
}
function pausedLog() {
  return [scene('mounted', 1000), scene('baseline', 6000, 5000, { pixels: { ...goodPixels } }),
    scene('frame', 61000, 60000, { pixels: { ...goodPixels } }),
    scene('paused', 91000, 90000, { enabled: false }),
    scene('frame', 121000, 90000, { enabled: false }),
    scene('resumed', 151000, 90000),
    scene('frame', 181000, 120000, { pixels: { ...goodPixels } }),
    ...ending(scene('final', 186000, 125000, { pixels: { ...goodPixels } }))];
}
const encode = rows => rows.map(row => typeof row === 'string' ? row : `scene_js ${JSON.stringify(row)}`).join('\n');
const sample = (rows, tag) => rows.find(row => row.tag === tag);
function analyze(rows, mode = 'context', options = {}) {
  return require(parser).analyze(encode(rows), { mode, minimumMs: 185000, doneMarker: true, ...options });
}
function passes(result) {
  assert.equal(result.status, 'pass', JSON.stringify(result.failures));
  assert.deepEqual(result.failures, []);
}
function fails(result, code) {
  assert.equal(result.status, 'fail', JSON.stringify(result));
  assert.ok(result.failures.some(failure => failure.code === code), JSON.stringify(result.failures));
}

test('context accepts three recoveries with progressive GPU uploads', () => {
  const result = analyze(contextLog());
  passes(result);
  assert.equal(result.elapsedMs, 32000);
  assert.equal(result.activeMs, 26000);
  assert.equal(result.pausedMs, 6000);
  assert.deepEqual(result.resourceBaseline, gpu);
  assert.deepEqual(result.resourceRanges.geometries, { min: 0, max: 118 });
});

test('a reporter between context restoration and the first renderer draw is valid', () => {
  const rows = contextLog();
  const i = rows.findIndex(row => row.tag === 'context-restored');
  rows.splice(i + 1, 0, { ...rows[i], tag: 'frame' });
  passes(analyze(rows));
});

test('stalled renderer cannot pass on driving frames, clock writes, or capture pixels', () => {
  const rows = soakLog();
  const baseline = sample(rows, 'baseline');
  for (const row of rows) {
    if (row.elapsedMs >= baseline.elapsedMs) row.renderDraws = baseline.renderDraws;
  }
  fails(analyze(rows, 'soak'), 'PROGRESS');
});

test('rendering while paused is not accepted as a frozen scene', () => {
  const rows = pausedLog();
  rows.find(row => row.tag === 'frame' && !row.enabled).renderDraws++;
  fails(analyze(rows, 'soak'), 'FROZEN');
});

test('soak counts eight hours from first mounted, not the five-second baseline', () => {
  const eightHours = 8 * 60 * 60 * 1000;
  const result = analyze(soakLog(eightHours), 'soak', { minimumMs: eightHours });
  passes(result);
  assert.equal(result.elapsedMs, eightHours);
  assert.equal(result.activeMs, eightHours);
  assert.equal(result.pausedMs, 0);
  assert.equal(result.sampleIntervalMs, 60000);
  assert.deepEqual(result.resourceRanges.geometries, { min: 118, max: 118 });
});

test('eight-hour soak rejects a renderer clock clamped at four hours', () => {
  const eightHours = 8 * 60 * 60 * 1000;
  const rows = soakLog(eightHours);
  for (const row of rows) {
    if (row.stats) row.stats.time = Math.min(row.stats.time, 4 * 60 * 60);
  }
  fails(analyze(rows, 'soak', { minimumMs: eightHours }), 'PROGRESS');
});

test('soak accounts for explicit pauses without calling wall-time active time', () => {
  const result = analyze(pausedLog(), 'soak');
  passes(result);
  assert.equal(result.elapsedMs, 185000);
  assert.equal(result.activeMs, 125000);
  assert.equal(result.pausedMs, 60000);
  assert.equal(result.unobservedMs, 0);
  assert.match(result.activityBasis, /not.*active|not.*rendering/i);
});

test('paused final may have no pixels and frozen counters', () => {
  const rows = pausedLog();
  const paused = sample(rows, 'paused');
  for (const row of rows) {
    if (row.elapsedMs > paused.elapsedMs) {
      if (row.tag === 'resumed') row.tag = 'paused';
      row.enabled = false;
      row.frames = paused.frames;
      row.renderDraws = paused.renderDraws;
      row.sceneTime = paused.sceneTime;
      row.pixels = null;
      if (row.stats) { row.stats.playing = false; row.stats.time = paused.stats.time; }
    }
  }
  passes(analyze(rows, 'soak'));
});

test('a short soak need not contain a minute sample', () => {
  passes(analyze(soakLog(10000), 'soak', { minimumMs: 10000 }));
});

test('analysis is deterministic, side-effect free, and accepts CRLF', () => {
  const log = encode(contextLog()).replaceAll('\n', '\r\n');
  const options = Object.freeze({ mode: 'context', doneMarker: true });
  const first = require(parser).analyze(log, options);
  passes(first);
  assert.deepEqual(require(parser).analyze(log, options), first);
});

const contextMutations = [
  ['missing restore', rows => rows.splice(rows.findIndex(row => row.tag === 'context-restored'), 1), 'ORDER'],
  ['reordered recovery', rows => {
    const i = rows.findIndex(row => row.tag === 'context-lost');
    [rows[i], rows[i + 2]] = [rows[i + 2], rows[i]];
  }, 'ORDER'],
  ['second mount', rows => rows.splice(2, 0, scene('mounted', 1001)), 'ORDER'],
  ['lost frame advances', rows => {
    const i = rows.findIndex(row => row.tag === 'context-lost');
    rows[i + 1].frames++;
  }, 'FROZEN'],
  ['restore resets scene time', rows => { sample(rows, 'context-restored').sceneTime = 0; }, 'FROZEN'],
  ['restore resets renderer time', rows => { sample(rows, 'context-restored').stats.time = 0; }, 'FROZEN'],
  ['after-restore frames stall', rows => {
    sample(rows, 'after-restore').frames = sample(rows, 'context-restored').frames;
  }, 'PROGRESS'],
  ['after-restore scene time stalls', rows => {
    sample(rows, 'after-restore').sceneTime = sample(rows, 'context-restored').sceneTime;
  }, 'PROGRESS'],
  ['black restored pixels', rows => { sample(rows, 'after-restore').pixels.bright = 0; }, 'PIXELS'],
  ['missing restored pixels', rows => { sample(rows, 'after-restore').pixels = null; }, 'PIXELS'],
  ['GL error', rows => { sample(rows, 'baseline').pixels.error = 1282; }, 'PIXELS'],
  ['pixel context still lost', rows => { sample(rows, 'after-restore').pixels.lost = true; }, 'PIXELS'],
  ['bad pixel dimensions', rows => { sample(rows, 'baseline').pixels.width = 0; }, 'PIXELS'],
  ['restore resource growth', rows => { sample(rows, 'context-restored').stats.geometries = gpu.geometries + 1; }, 'RESOURCE_GROWTH'],
  ['post-restore sample has no GPU resources', rows => { sample(rows, 'after-restore').stats.programs = 0; }, 'RESOURCE_EMPTY'],
  ['post-restore sample has no draws', rows => { sample(rows, 'after-restore').stats.drawCalls = 0; }, 'DRAWS'],
  ['wrong cumulative losses', rows => { sample(rows, 'final').lossCount = 2; }, 'COUNTERS'],
  ['wrong cumulative restores', rows => { sample(rows, 'final').restoreCount = 2; }, 'COUNTERS'],
  ['lost flag inconsistent', rows => { sample(rows, 'context-restored').lost = true; }, 'STATE'],
  ['missing final', rows => rows.splice(rows.findIndex(row => row.tag === 'final'), 1), 'ORDER'],
  ['missing unmount receipt', rows => rows.splice(rows.findIndex(row => row.tag === 'unmounted'), 1), 'ORDER'],
  ['unmount retains stats', rows => { sample(rows, 'unmounted').stats = { ...sample(rows, 'final').stats }; }, 'UNMOUNT'],
  ['missing native completion', rows => rows.splice(rows.indexOf('scene_complete'), 1), 'TERMINATION'],
  ['missing done state', rows => rows.pop(), 'TERMINATION'],
  ['native completion before unmount', rows => {
    rows.splice(rows.indexOf('scene_complete'), 1); rows.unshift('scene_complete');
  }, 'TERMINATION'],
  ['duplicate native completion', rows => rows.push('scene_complete'), 'TERMINATION'],
  ['frame after unmount', rows => rows.push(scene('frame', 34000)), 'ORDER'],
  ['timestamp reverses', rows => { sample(rows, 'after-restore').timestamp = 1; }, 'TIME_ORDER'],
  ['elapsed clock resets', rows => { sample(rows, 'after-restore').elapsedMs = 1; }, 'TIME_ORDER'],
  ['important JSON is truncated', rows => rows.splice(3, 0, 'scene_js {"kind":"scene","tag":"frame"'), 'JSON'],
  ['JSON is null', rows => rows.push('scene_js null'), 'SCHEMA'],
  ['JSON is array', rows => rows.push('scene_js []'), 'SCHEMA'],
  ['missing frame count', rows => { delete sample(rows, 'after-restore').frames; }, 'SCHEMA'],
  ['stats is missing before unmount', rows => { sample(rows, 'after-restore').stats = null; }, 'SCHEMA'],
];
for (const [name, mutate, code] of contextMutations) {
  test(`context rejects ${name}`, () => {
    const rows = contextLog();
    mutate(rows);
    fails(analyze(rows), code);
  });
}

for (const error of [
  { kind: 'scene_error', error: 'boom' }, { kind: 'scene_mount_error' },
  { kind: 'scene_context_error' }, { kind: 'scene_capture_error' }, { kind: 'scene_mount_failed' },
  'eval tag=scene-context-loss error=failed', 'recovery_terminal attempts>=3 window=120s',
  'scene_finish_timeout',
]) {
  test(`errors are fatal even after completion: ${JSON.stringify(error)}`, () => {
    fails(analyze(contextLog().concat(error)), 'PROBE_ERROR');
  });
}

test('a missing done.ready marker cannot be inferred from native done state', () => {
  fails(analyze(contextLog(), 'context', { doneMarker: false }), 'DONE_MARKER');
  fails(require(parser).analyze(encode(contextLog()), { mode: 'context' }), 'DONE_MARKER');
});

const soakMutations = [
  ['frames stop', rows => { rows.filter(row => row.tag === 'frame')[1].frames = sample(rows, 'frame').frames; }, 'PROGRESS'],
  ['scene time stops', rows => { rows.filter(row => row.tag === 'frame')[1].sceneTime = sample(rows, 'frame').sceneTime; }, 'PROGRESS'],
  ['renderer time stops', rows => { rows.filter(row => row.tag === 'frame')[1].stats.time = sample(rows, 'frame').stats.time; }, 'PROGRESS'],
  ['draws stop despite frame increments', rows => { sample(rows, 'frame').stats.drawCalls = 0; }, 'DRAWS'],
  ['black frame', rows => { sample(rows, 'frame').pixels.bright = 0; }, 'PIXELS'],
  ['not warmed baseline', rows => { sample(rows, 'baseline').stats.warmed = false; }, 'WARMUP'],
  ['geometry grows temporarily', rows => { sample(rows, 'frame').stats.geometries++; }, 'RESOURCE_GROWTH'],
  ['textures grow temporarily', rows => { sample(rows, 'frame').stats.textures++; }, 'RESOURCE_GROWTH'],
  ['programs grow temporarily', rows => { sample(rows, 'frame').stats.programs++; }, 'RESOURCE_GROWTH'],
  ['missing all minute samples', rows => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].tag === 'frame') rows.splice(i, 1);
  }, 'GAP'],
  ['wall clock gap despite advancing performance clock', rows => {
    for (const row of rows) if (row.elapsedMs >= 121000) row.timestamp += 180000;
  }, 'GAP'],
  ['unexpected context recovery', rows => { sample(rows, 'frame').tag = 'context-restored'; }, 'ORDER'],
  ['missing before-unmount', rows => rows.splice(rows.findIndex(row => row.tag === 'before_unmount'), 1), 'ORDER'],
  ['rebuild', rows => rows.splice(3, 0, scene('mounted', 61000, 0)), 'ORDER'],
];
for (const [name, mutate, code] of soakMutations) {
  test(`soak rejects ${name}`, () => {
    const rows = soakLog();
    mutate(rows);
    fails(analyze(rows, 'soak'), code);
  });
}

test('soak fails if duration is below the explicit minimum', () => {
  fails(analyze(soakLog(), 'soak', { minimumMs: 185001 }), 'DURATION');
});

test('soak rejects movement while paused', () => {
  const rows = pausedLog();
  rows.find(row => row.tag === 'frame' && !row.enabled).sceneTime++;
  fails(analyze(rows, 'soak'), 'FROZEN');
});

test('gaps over two minutes are unobserved, not active time', () => {
  const rows = soakLog(305000).filter(row => row.tag !== 'frame' || row.elapsedMs >= 241000);
  const result = analyze(rows, 'soak');
  fails(result, 'GAP');
  assert.ok(result.unobservedMs > 120000);
  assert.ok(result.activeMs < result.elapsedMs);
});

test('frequent policy events cannot hide missing minute frame samples', () => {
  const rows = soakLog(305000);
  for (const row of rows) if (row.tag === 'frame') { row.tag = 'resumed'; row.pixels = null; }
  fails(analyze(rows, 'soak'), 'GAP');
});

test('a gap of exactly 120000ms is allowed', () => {
  const rows = soakLog();
  rows.splice(rows.findIndex(row => row.tag === 'frame' && row.elapsedMs === 121000), 1);
  passes(analyze(rows, 'soak'));
});

test('bad options and empty evidence cannot pass', () => {
  fails(analyze([], 'context'), 'ORDER');
  fails(analyze(soakLog(), 'unknown'), 'OPTIONS');
  for (const minimumMs of [undefined, -1, 0, NaN, Infinity, '185000']) {
    fails(analyze(soakLog(), 'soak', { minimumMs }), 'OPTIONS');
  }
});

test('redundant resumed events cannot hide stalled active frame samples', () => {
  const rows = soakLog();
  const baseline = sample(rows, 'baseline');
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].tag !== 'frame') continue;
    rows[i].frames = baseline.frames;
    rows[i].sceneTime = baseline.sceneTime;
    rows[i].stats.time = baseline.stats.time;
    rows.splice(i, 0, { ...rows[i], tag: 'resumed', pixels: null });
  }
  fails(analyze(rows, 'soak'), 'PROGRESS');
});

test('context after-restore must provide pixels even if a pause intervened', () => {
  const rows = contextLog();
  const i = rows.findIndex(row => row.tag === 'after-restore');
  const snapshot = rows[i];
  rows.splice(i, 1,
    { ...snapshot, tag: 'paused', enabled: false, pixels: null, stats: { ...snapshot.stats, playing: false } },
    { ...snapshot, enabled: false, pixels: null, stats: { ...snapshot.stats, playing: false } },
    { ...snapshot, tag: 'resumed', pixels: null });
  fails(analyze(rows), 'PIXELS');
});

test('JSON-escaped error kinds are still fatal', () => {
  fails(analyze(contextLog().concat('scene_js {"kind":"scene_\\u0065rror"}')), 'PROBE_ERROR');
});

test('CLI keeps default printing and emits JSON plus a failing exit code for verification', t => {
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'parse-scene-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'probe.log');
  const marker = path.join(dir, 'done.ready');
  fs.writeFileSync(file, encode(contextLog()));
  fs.writeFileSync(marker, '');
  const run = args => spawnSync(process.execPath, [parser, ...args], { encoding: 'utf8' });
  let result = run([file]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /baseline mounted=true frames=150 playing=true warmed=true geo=118 tex=12 prog=6/);
  result = run([file, '--verify-context']);
  assert.equal(result.status, 0, result.stderr);
  passes(JSON.parse(result.stdout));
  fs.unlinkSync(marker);
  result = run(['--verify-context', file]);
  assert.equal(result.status, 1);
  fails(JSON.parse(result.stdout), 'DONE_MARKER');
  fs.writeFileSync(marker, '');
  fs.writeFileSync(file, encode(soakLog()));
  result = run(['--verify-soak', '185000', file]);
  assert.equal(result.status, 0, result.stderr);
  passes(JSON.parse(result.stdout));
  result = run([file, '--verify-soak', '185001']);
  assert.equal(result.status, 1);
  fails(JSON.parse(result.stdout), 'DURATION');
  fs.appendFileSync(file, '\nscene_js {"kind":"scene",');
  result = run([file, '--verify-soak', '185000']);
  assert.equal(result.status, 1);
  fails(JSON.parse(result.stdout), 'JSON');
  for (const args of [[], [file, '--verify-soak'], [file, '--verify-soak', '-1'],
    [file, '--verify-context', '--verify-soak', '1'], [file, '--unknown']]) {
    result = run(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    fails(JSON.parse(result.stdout), 'OPTIONS');
  }
  result = run([path.join(dir, 'missing.log'), '--verify-context']);
  assert.equal(result.status, 2);
  fails(JSON.parse(result.stdout), 'INPUT');
});
