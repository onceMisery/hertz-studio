#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 帧门契约检查（零依赖、不触网）。
//
//   node scripts/check-frame-gates.js
//
// 治的是 docs/research/mineradio-full-assessment.md §5.1 那个 bug：帧门原来是
// 「按毫秒累积、够点就清零」，兑现出来的帧率只能是刷新率的整数分之一且**向下**取，
// 而各档位表写的是绝对 fps。结果 60Hz 屏上声明 48 跑 30、声明 40 跑 30、声明 24 跑
// 20 —— 看档位数字做降级判断的人全是错的，而画面不会报错。
//
// 现在帧门的语义摊开成「每 N 个 rAF 给一帧」，N 由**实测**刷新率换算，且只往下取
// （预算语义：宁可少给帧，不许多给）。这里钉四件事：
//
//   1. 换算：N = ceil(刷新率 / 目标)，任何目标都不兑现成超过预算的帧率；
//   2. 兑现：跑出来的帧率恰好是 hz / N，且给帧的间隔是整 N 帧，不抖不漂；
//   3. 停机：fpsFn 报 0 就是这个门一帧都不要（0 的含义全局唯一，不是"不封顶"）；
//   4. 档位表不许再说谎：写死的目标帧率必须同时是 60 与 120 的整数分频。
//
// 判定用的函数是从 plugin/ui/stage.js 里整段抠出来执行的，不是照着源码另写一份：
// 换算改了，这里跟着一起变。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'plugin', 'ui');

let checks = 0;
let failures = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error('  ✗ ' + label);
  }
}
function eq(a, b, label) { ok(a === b, label + '（期望 ' + JSON.stringify(b) + '，实得 ' + JSON.stringify(a) + '）'); }
function section(name) { console.log('\n' + name); }

function read(file) { return fs.readFileSync(path.join(WEB, file), 'utf8'); }

/// 从源码里按名字抠出一个完整函数（按花括号配平），原样执行。
function grabFn(src, head) {
  const at = src.indexOf(head);
  if (at < 0) throw new Error('抠不到 ' + head);
  let i = src.indexOf('{', at);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(at, j + 1);
    }
  }
  throw new Error(head + ' 花括号没配平');
}

/// 从源码里抠出「从某标记到某标记」的一段（含前不含后）。
function grabBetween(src, fromMark, toMark, label) {
  const a = src.indexOf(fromMark);
  const b = src.indexOf(toMark, a);
  if (a < 0 || b < 0) throw new Error('抠不到段落 ' + (label || fromMark));
  return src.slice(a, b);
}

const stageSrc = read('stage.js');
const gateCore = [
  'var gates = [];',
  // 估计器 + 换算：整段搬过来执行（含它自己声明的状态变量）。
  grabBetween(stageSrc, 'var HZ_WINDOW', 'function defineGate(', '帧门换算'),
  grabFn(stageSrc, 'function runGates('),
  grabFn(stageSrc, 'function anyGateWants('),
].join('\n');

const sandbox = { console, Math, isFinite };
vm.createContext(sandbox);
vm.runInContext(gateCore + '\nthis.gates = gates; this.sampleDisplayHz = sampleDisplayHz;'
  + ' this.gateDivisor = gateDivisor; this.runGates = runGates; this.anyGateWants = anyGateWants;'
  + ' this.readHz = function () { return displayHz; };', sandbox, { filename: 'frame-gates.js' });
const api = {
  gates: sandbox.gates,
  sampleDisplayHz: sandbox.sampleDisplayHz,
  gateDivisor: sandbox.gateDivisor,
  runGates: sandbox.runGates,
  anyGateWants: sandbox.anyGateWants,
  hz: sandbox.readHz,
};

/// 把刷新率喂进估计器：给它 n 个该刷新率的标准间隔。
function feedHz(hz, times) {
  const gap = 1000 / hz;
  for (let i = 0; i < (times || 40); i += 1) api.sampleDisplayHz(gap);
}

(async function main() {
  section('换算：N = ceil(刷新率 / 预算)，任何目标都不兑现成超过预算的帧率');
  {
    feedHz(60);
    eq(api.hz(), 60, '60Hz 的 16.666ms 间隔估回 60');
    // 59.94 / 119.88 这类标称值必须吸附回整数，否则 N 会在两档之间来回跳。
    api.gates.length = 0;
    const s2 = { console, Math, isFinite };
    vm.createContext(s2);
    vm.runInContext(gateCore + '\nthis.sample = sampleDisplayHz; this.hz = function () { return displayHz; };'
      + ' this.div = gateDivisor;', s2);
    for (let i = 0; i < 40; i += 1) s2.sample(1000 / 59.94);
    ok(Math.abs(s2.hz() - 60) < 0.6, '59.94Hz 吸附到 60（实得 ' + s2.hz().toFixed(2) + '）');
    for (let i = 0; i < 40; i += 1) s2.sample(1000 / 119.88);
    ok(Math.abs(s2.hz() - 120) < 1.2, '119.88Hz 吸附到 120（实得 ' + s2.hz().toFixed(2) + '）');
    for (let i = 0; i < 40; i += 1) s2.sample(1000 / 143.98);
    ok(Math.abs(s2.hz() - 144) < 1.5, '143.98Hz 吸附到 144（实得 ' + s2.hz().toFixed(2) + '）');
    // 掉帧与切标签页的异常间隔不许进样本（否则刷新率被算低、档位整体往下掉）。
    for (let i = 0; i < 10; i += 1) s2.sample(3000);
    ok(Math.abs(s2.hz() - 144) < 2, '切回前台的 3000ms 间隔没把估计值拖走');
  }
  {
    // 预算的上界性质：1 到 240 之间任何目标，兑现出来的帧率都不许多于请求值。
    // 下界只对「不超过刷新率」的目标要求：60Hz 屏上任何整数分频都给不出 >60，
    // 所以目标高于刷新率时「兑现成 60」是物理上限，不算撒谎。
    for (const hz of [60, 72, 90, 120, 144]) {
      api.gates.length = 0;
      const s3 = { console, Math, isFinite };
      vm.createContext(s3);
      vm.runInContext(gateCore + '\nthis.div = gateDivisor; this.set = function (v) { displayHz = v; };', s3);
      s3.set(hz);
      for (let target = 1; target <= 240; target += 1) {
        const n = s3.div(target);
        const achieved = hz / n;
        if (achieved > target + 1e-9) {
          failures += 1;
          checks += 1;
          console.error(`  ✗ ${hz}Hz 上目标 ${target} 兑现成 ${achieved.toFixed(2)}，超过预算`);
          break;
        }
        if (target <= hz && achieved < target / 2) {
          failures += 1;
          checks += 1;
          console.error(`  ✗ ${hz}Hz 上目标 ${target} 只兑现到 ${achieved.toFixed(2)}，掉了一半以上`);
          break;
        }
      }
      checks += 1;
    }
    ok(true, '各刷新率上「不超预算、预算内不少一半」对 1–240 全部成立');
  }

  section('兑现：给帧间隔恰好是整 N 帧，不抖不漂');
  {
    api.gates.length = 0;
    feedHz(60);
    const fired = [];
    let frames = 0;
    let waited = 0;
    api.gates.push({
      name: 'probe',
      fpsFn: () => 30,
      tickFn: (dt) => { fired.push({ frame: frames, dt }); waited += dt; },
      skip: 0,
      wait: 0,
    });
    for (frames = 1; frames <= 120; frames += 1) api.runGates(1000 / 60);
    eq(fired.length, 60, '60Hz 上 30fps 的门在 120 帧里正好给 60 帧');
    const gaps = fired.slice(1).map((f, i) => f.frame - fired[i].frame);
    ok(gaps.every((g) => g === 2), '给帧间隔恒为 2 帧（不是 1/3 交替，那正是 judder 的来源）');
    ok(Math.abs(fired[0].dt - 33.333) < 0.5, 'tickFn 拿到的是累积真实毫秒（33.3ms，不是 16.7）');
  }
  {
    // 非整数分频的档位（36@144）也必须落在整 N 帧上。
    api.gates.length = 0;
    const s4 = { console, Math, isFinite };
    vm.createContext(s4);
    vm.runInContext(gateCore + '\nthis.pushGate = function (f, t) { gates.push({ name: "x", fpsFn: f, tickFn: t, skip: 0, wait: 0 }); };'
      + ' this.run = runGates; this.feed = sampleDisplayHz;', s4);
    for (let i = 0; i < 40; i += 1) s4.feed(1000 / 144);
    const at = [];
    let n = 0;
    s4.pushGate(() => 30, () => at.push(n));
    for (n = 1; n <= 144; n += 1) s4.run(1000 / 144);
    // 144 上 30 的最近整数分频是 5（28.8fps）。用 round 会取 4 档 = 36fps，
    // 那就是「要 30 给 36」，预算不再成立 —— 这里钉的正是选了 ceil 这件事。
    eq(at.length, 28, '144Hz 上 30fps 预算给 28 帧（间隔 5 帧，28.8fps）');
    const step = at.slice(1).map((v, i) => v - at[i]);
    ok(step.every((v) => v === 5), '144Hz 上的间隔是整 5 帧（不是 4/5 交替）');
    ok(at.length <= 30, '兑现出来的帧率不超过预算');
  }

  section('停机：fpsFn 报 0 就是一帧都不要');
  {
    api.gates.length = 0;
    feedHz(60);
    let hits = 0;
    api.gates.push({ name: 'idle', fpsFn: () => 0, tickFn: () => { hits += 1; }, skip: 0, wait: 0 });
    for (let i = 0; i < 60; i += 1) api.runGates(16.7);
    eq(hits, 0, '报 0 的门一帧都不给');
    eq(api.anyGateWants(), false, '只有报 0 的门时主循环可以停机');
    api.gates.push({ name: 'live', fpsFn: () => 30, tickFn: () => {}, skip: 0, wait: 0 });
    eq(api.anyGateWants(), true, '有一个要帧的门就不许停');
    // 从「要帧」切回 0 时，累加器必须归零：否则它下次醒来会立刻补一帧（假响应）。
    const g = api.gates[1];
    g.fpsFn = () => 0;
    for (let i = 0; i < 5; i += 1) api.runGates(16.7);
    eq(g.wait, 0, '报 0 之后 wait 被清掉');
    eq(g.skip, 0, '报 0 之后帧计数被清掉');
  }

  section('档位表不许再说谎：写死的帧率必须同时整除 60 与 120');
  {
    const declared = [];
    const grabFps = (file, mark) => {
      const src = read(file);
      const at = src.indexOf(mark);
      if (at < 0) throw new Error(file + ' 找不到 ' + mark);
      const end = src.indexOf('];', at);
      const body = src.slice(at, end);
      for (const m of body.matchAll(/fps:\s*(\d+)/g)) declared.push({ file, value: Number(m[1]) });
      for (const m of body.matchAll(/dpr:\s*[\d.]+/g)) { /* dpr 不在本检查范围 */ }
    };
    grabFps('creative-stage.js', 'var TIERS = [');
    grabFps('stage-particles.js', 'var TIERS = [');
    for (const f of ['handdrawn.js', 'backgrounds.js']) {
      const src = read(f);
      const m = /var (?:HZ|BG_FPS) = (\d+)/.exec(src);
      if (m) declared.push({ file: f, value: Number(m[1]) });
    }
    // stage.js 的歌词档位：把函数抠出来，按各分支取值。
    const lyricSrc = grabFn(stageSrc, 'function lyricsTargetFps(');
    const lz = { hidden: false, reduced: false, playing: true, tier: 2, document: { body: { classList: { contains: () => false } } } };
    vm.createContext(lz);
    vm.runInContext(lyricSrc + '\nthis.read = lyricsTargetFps;', lz);
    const lyricVals = [];
    for (const tier of [0, 1, 2]) { lz.tier = tier; lyricVals.push(lz.read()); }
    lz.playing = false; lyricVals.push(lz.read());
    lz.playing = true; lz.reduced = true; lyricVals.push(lz.read());
    lz.reduced = false; lz.hidden = true; lyricVals.push(lz.read());
    for (const v of lyricVals) declared.push({ file: 'stage.js:lyricsTargetFps', value: v });

    ok(declared.length >= 10, '抓到足够多的声明档位（实得 ' + declared.length + '）');
    for (const d of declared) {
      if (d.value === 0) continue;   // 0 = 停机，不是帧率
      ok(60 % d.value === 0 && 120 % d.value === 0,
        `${d.file} 的档位 ${d.value}fps 不是 60 与 120 的公因数（会兑现成别的数）`);
    }
    // 三维层的 240 = 「每个 rAF 都给」是刻意约定，不是漏网的谎数。
    ok(/return 240;/.test(stageSrc) || /return 240;/.test(read('stage3d.js')),
      '240（每帧都给）这个约定还在，帧门未封顶时的写法');
  }

  console.log(`\n帧门契约检查：${checks} 项` + (failures ? `，${failures} 项失败` : '全部通过'));
  process.exit(failures ? 1 : 0);
}());
