#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 跨模块性能探针的契约检查（零依赖、不触网、无浏览器）。
//
//   node scripts/check-perf-probe.js
//
// 探针补的是「全局口径」那一段：各面板本来就有自己的 stats()，但没有一份共同
// 账本能回答「哪个环节累计最花时间」。这类东西最坏的失效不是读不到数，而是
// **探针自己变成了被测对象的一部分**：一次快照顺手记一笔账、一个缺席的面板被
// 补成 0、一处裸调用在探针没装载时把整条路径打断。所以断言按这四组排：
//
//   1. 记账原语（mark/markSince/count/topByTotal）的算术与窗口语义 —— 全在
//      vm 沙箱里真跑，喂假时钟，不靠读源码猜。
//   2. 快照的来源只从面板 stats() 里**已存在**的键挑：字段名对着真实模块文件
//      比一遍，发明出来的字段与漂掉的字段都要红。
//   3. 缺席、抛错、返回非对象三种坏来源都不许让 snapshot 抛；取快照不记账、
//      返回的是读数而不是活引用。
//   4. 四处注册点（index.html 的 script、main.rs 的 include_str! 常量、
//      .route、ASSET_FINGERPRINT_INPUTS）—— 少任何一处都不会报错，只会「这块
//      永远是空的」，所以四处必须齐全。插件按 ui 目录打包，同样核对入口与包含项。
//
// 第 4 组同时扫一遍「调用点必须与 typeof/&& 守卫写在同一行」：探针是可选件，
// 裸调用等于把一个统计工具升级成运行期故障。扫描器自己也被正反两个样例验过，
// 免得它是个只会点头的守卫。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PROBE_REL = 'plugin/ui/perf-probe.js';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let checks = 0;
let failures = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error('  ✗ ' + label);
  }
}
function eq(a, b, label) {
  ok(a === b, label + '（期望 ' + JSON.stringify(b) + '，实得 ' + JSON.stringify(a) + '）');
}
function section(name) { console.log('\n' + name); }

/// 从 marker 之后第一个 `{` 起取到配平的 `}`（含两端）。stats() 这几份里没有
/// 字符串带花括号，所以按字符计数够用，比按缩进猜行数可靠。
function blockAfter(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const i = text.indexOf('{', at);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

/// 取对象字面量**顶层**（花括号深度 1）的键名。深度算进去是为了不让嵌套回调里
/// 同名的键冒充「这块面板真的暴露了这个字段」。
function topLevelKeys(objLiteral) {
  const keys = [];
  let depth = 0;
  let i = 0;
  while (i < objLiteral.length) {
    const c = objLiteral[i];
    if (c === '{') { depth += 1; i += 1; continue; }
    if (c === '}') { depth -= 1; i += 1; continue; }
    if (depth === 1 && /[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*(?=\s*:)/.exec(objLiteral.slice(i));
      if (m) {
        keys.push(m[0]);
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return keys;
}

/// 某个模块 `stats: function () { return {…} }` 暴露的顶层字段名。
function statsKeys(rel, marker) {
  const src = read(rel);
  const body = blockAfter(src, marker);
  if (!body) return null;
  const retAt = body.indexOf('return');
  if (retAt < 0) return null;
  const obj = blockAfter(body.slice(retAt), '');
  return obj ? topLevelKeys(obj) : null;
}

/// 把探针源码里的 pickFields([...]) 白名单读出来，作为「它声称要接哪些字段」的依据。
function pickLists(src) {
  const out = [];
  const re = /pickFields\(\[([^\]]*)\]\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push(m[1].split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean));
  }
  return out;
}

/// 假时钟：探针读 performance.now，沙箱里没有真 performance，时间与「窗口」全
/// 由这里推进，断言才能钉住具体毫秒。
function loadProbe(opts) {
  const o = opts || {};
  const clock = { value: o.start == null ? 1000 : o.start };
  const ctx = {};
  if (o.clock === 'date') ctx.Date = { now: () => clock.value };
  else ctx.performance = { now: () => clock.value };
  // 探针里那句 `typeof window !== 'undefined' ? window : this` 两条分支都要能跑。
  if (!o.noWindow) ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read(PROBE_REL), ctx);
  return { P: ctx.HertzPerf, clock: clock, ctx: ctx };
}

/// 四个来源面板的假实现，字段名照真实 stats() 的形状给（缺了就不该出现在快照里）。
function fakePanels(overrides) {
  const base = {
    Stage: {
      gateRates: () => [{ name: 'particles', target: 30, divisor: 4, achieved: 30 }],
      displayHz: () => 119.876,
      tier: () => 1,
      isLowFx: () => false
    },
    Stage3D: {
      stats: () => ({
        fps: 30, hz: 60, costMs: 8.44, pressure: 1.2, divisor: 2, quality: 2, dpr: 1.5,
        stage: 'orbit', audio: { bass: 1 }, camera: { theta: 0 }, time: 1234, buffer: '1920x1080'
      })
    },
    CreativeStage: {
      stats: () => ({
        active: true, stageActive: true, scene: 'city', section: 2,
        fps: 60, tier: 1, dprScale: 0.75, animations: 3,
        beats: 1, energy: 0.5, agg: [0.1], cueCount: 2, bindCount: 1,
        probe: { loss: 0.12, rounds: 4, step: 1, running: false, muted: true }
      })
    },
    Backgrounds: {
      stats: () => ({
        type: 'flow', fps: 12, host: 'home', depthMode: 'flat', depthEffective: false,
        wallReady: true, wallTex: 384, size: '384x216', palette: ['#000000']
      })
    }
  };
  const merged = Object.assign(base, overrides || {});
  return merged;
}

function loadWithPanels(overrides, opts) {
  const loaded = loadProbe(opts);
  Object.entries(overrides || {}).forEach(([name, value]) => {
    if (value === null) delete loaded.ctx[name];
    else loaded.ctx[name] = value;
  });
  return loaded;
}

/// 去掉注释后的源码（守卫扫描用）：注释里写 HertzPerf 不该算调用点。
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//');
      return at < 0 ? line : line.slice(0, at);
    })
    .join('\n');
}

const GUARD = /typeof\s+[\w.$]*HertzPerf|HertzPerf\s*(&&|\?\?)|\?\.\s*HertzPerf|HertzPerf\s*\?\s*:/;

/// 找出「裸调用」：调用了探针成员，但守卫没写在同一行。
function guardViolations(text) {
  const code = stripComments(text);
  const bad = [];
  code.split('\n').forEach((line, idx) => {
    if (!/HertzPerf\s*\.\s*(mark|markSince|begin|measure|count|summary|snapshot|reset|now|setEnabled|state|limits)\b/.test(line)) return;
    if (GUARD.test(line)) return;
    bad.push(idx + 1);
  });
  return bad;
}

function uiSourceFiles() {
  const dir = path.join(ROOT, 'plugin', 'ui');
  const out = [];
  const walk = (d, rel) => {
    fs.readdirSync(d, { withFileTypes: true }).forEach((ent) => {
      if (ent.name === 'node_modules' || ent.name === 'vendor') return;
      const abs = path.join(d, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else if (ent.name.endsWith('.js')) out.push('plugin/ui/' + r);
    });
  };
  walk(dir, '');
  return out;
}

(function main() {
  section('全局形状与零依赖');
  {
    const src = read(PROBE_REL);
    ok(!/\brequire\s*\(|\bimport\s|\bexport\s/.test(src), '零依赖：不 require、不 import');
    ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB/.test(src),
      '探针不许自己产生网络或存储：它只读内存里已有的数');
    ok(!/\bdocument\b|querySelector|addEventListener/.test(src),
      '不碰 DOM：探针不该因为页面结构变化而失效，也不该改页面');
    ok(!/requestAnimationFrame|setInterval|setTimeout/.test(src), '探针不创建帧循环或轮询排期');
    ok(/^\s*\/\/ SPDX-License-Identifier: MIT/m.test(src) && /Copyright \(c\) 2026 hertz-studio contributors/.test(src),
      '文件头是本项目的 SPDX + 版权行');
    ok(/\(function \(global\)[\s\S]*\}\(typeof window !== 'undefined' \? window : this\)\);/.test(src),
      '零依赖 IIFE 挂到 window（与 plugin/ui 其它模块同一写法）');
    const forbidden = /\b(mineradio|vcpchat|vcp-|folia)\b/i;
    ok(!forbidden.test(src), '标识符与文案里不许带上游项目名，出处只写在 NOTICE');

    const { P, ctx } = loadProbe();
    const added = Object.keys(ctx).filter((k) => !['performance', 'Date', 'window'].includes(k));
    eq(added.join(','), 'HertzPerf', '模块只挂一个全局');
    ok(/^Hertz/.test(added[0]), '全局名用的是本项目前缀');
    ['now', 'mark', 'markSince', 'begin', 'measure', 'count', 'summary', 'snapshot', 'reset', 'setEnabled']
      .forEach((fn) => eq(typeof P[fn], 'function', '对外有 ' + fn + '()'));
    ok(typeof P.version === 'string' && P.version.length > 0, '版本号是带内容的字符串（重复装载判定靠它）');
    eq(Object.getPrototypeOf(P.state.metrics), null,
      '账本是无原型对象：指标名是调用方给的任意字符串');
  }

  section('mark：同名累加');
  {
    const { P } = loadProbe();
    P.mark('paint', 10);
    P.mark('paint', 5);
    const m = P.summary().metrics.paint;
    eq(m.count, 2, '同名 mark 累加笔数');
    eq(m.totalMs, 15, '累计耗时相加');
    eq(m.avgMs, 7.5, '均值 = 累计 / 笔数');
    eq(m.maxMs, 10, '最大值留峰值');
    eq(m.lastMs, 5, 'lastMs 是最近一笔，不是最大一笔');
    eq(JSON.stringify(m.samples), '[10,5]', '样本留每笔的形状');

    // 脏数据一票否决：一笔 NaN 就能把 totalMs 变成 NaN，然后整张榜永远为空。
    const before = P.summary().metrics.paint;
    P.mark('paint', 'abc');
    P.mark('paint', -3);
    P.mark('paint', Infinity);
    P.mark('paint', undefined);
    P.mark('paint', null);
    P.mark('paint', false);
    P.mark('paint', '5');
    P.mark('paint', '');
    const after = P.summary().metrics.paint;
    eq(after.count, before.count, '非有限值与负数一笔都不入账');
    eq(after.totalMs, before.totalMs, '脏数据不许污染累计值');
    eq(P.summary().metrics.scratch, undefined, '从没 mark 过的名字不该凭空长出条目');
    P.mark('scratch', 0);
    eq(P.summary().metrics.scratch.count, 1, '0 毫秒是合法读数（缓存命中就该如实记 0）');
    eq(P.summary().metrics.scratch.totalMs, 0, '0 不应当被当成「没给值」');
  }
  {
    // 样本环：留形状不留全量。跑几小时之后先撑爆内存的是「样本数组无限涨」。
    const { P } = loadProbe();
    for (let i = 1; i <= 120; i += 1) P.mark('ring', i);
    eq(P.state.metrics.ring.samples.length, P.limits.samplesPerMetric,
      '内部样本封顶在 MAX_SAMPLES_PER_METRIC');
    eq(P.state.metrics.ring.samples[0], 31, '超出上限挤掉最旧的，不是新的');
    const tail = P.summary().metrics.ring.samples;
    eq(tail.length, P.limits.sampleTail, '快照只给尾部若干条（够看形状，不是导出）');
    eq(tail[tail.length - 1], 120, '尾部最后一条是最近那笔');
    eq(P.state.metrics.ring.totalMs, 7260, '样本截断不许影响累计值');
  }
  {
    const { P } = loadProbe();
    eq(P.mark('off', 3).count, 1, '默认开启时正常入账');
    eq(P.setEnabled(false), false, 'setEnabled(false) 关掉记账');
    eq(P.mark('off', 999), null, '关掉后 mark 不记账也不返回条目');
    eq(P.count('off'), 0, '关掉后 count 返回 0');
    eq(P.summary().metrics.off.count, 1, '关掉之前的账还在（关记账 ≠ 清账）');
    eq(P.summary().enabled, false, '快照如实报自己是被关掉的，别让空榜看起来像没问题');
    P.setEnabled(true);
    eq(P.mark('off', 4).lastMs, 4, '重新开启后继续累计');
  }

  section('markSince / begin / measure：窗口语义');
  {
    const { P, clock } = loadProbe({ start: 5000 });
    const t0 = P.now();
    eq(t0, 5000, 'now() 走 performance.now（沙箱里就是那把假时钟）');
    clock.value += 60;
    eq(P.markSince('layout', t0).totalMs, 60, 'markSince 记的是「起点 → 调用时刻」这段窗口');
    clock.value += 40;
    eq(P.markSince('layout', t0).totalMs, 160, '两次完整窗口分别为 60 与 100，累计 160');
    eq(P.summary().metrics.layout.lastMs, 100, '最近一笔仍是从起点算起的完整 100ms');
    eq(P.summary().metrics.layout.count, 2, '两次都入账');
    clock.value += 20;
    eq(P.markSince('epoch', 0).totalMs, 5120, '0 是合法起点（性能时间轴的原点就是 0）');
  }
  {
    // 参考实现写的是 Number(start || 0)：漏传起点会记下一笔「从开机到现在」。
    // 那个区间没人测过，却几乎必然排第一，榜当场作废 —— 这条偏离必须钉住。
    const { P } = loadProbe({ start: 5000 });
    eq(P.markSince('oops'), null, '漏传起点不记账');
    eq(P.markSince('oops', undefined), null, 'undefined 起点不记账');
    eq(P.markSince('oops', 'abc'), null, '非数字起点不记账');
    eq(P.markSince('oops', null), null, 'null 不是性能时间轴原点');
    eq(P.markSince('oops', ''), null, '空字符串不是性能时间轴原点');
    eq(P.summary().metrics.oops, undefined, '缺起点的调用一笔都不该留下');
    eq(P.summary().topByTotal.length, 0, '榜里也不该有那条开机至今的假第一名');
  }
  {
    const { P, clock } = loadProbe({ start: 1000 });
    const doneA = P.begin('decode');
    clock.value += 30;
    const doneB = P.begin('decode');
    clock.value += 10;
    eq(doneB().totalMs, 10, 'begin() 的窗口从它自己的调用点算');
    clock.value += 5;
    eq(doneA().totalMs, 55, '并起的两个窗口分别为 10 与 45，累计 55');
    eq(P.summary().metrics.decode.lastMs, 45, '窗口 A 从自己的起点算起');
    eq(P.summary().metrics.decode.count, 2, '同一个名字共用一条账');
  }
  {
    const { P, clock } = loadProbe({ start: 1000 });
    eq(P.measure('work', () => { clock.value += 40; return 42; }), 42, 'measure 透传返回值');
    eq(P.summary().metrics.work.totalMs, 40, 'measure 把这次的成本入账');
    let caught = null;
    try {
      P.measure('boom', () => { clock.value += 7; throw new Error('炸了'); });
    } catch (e) { caught = e.message; }
    eq(caught, '炸了', 'measure 不许吞掉被测代码的异常');
    eq(P.summary().metrics.boom.totalMs, 7, '抛异常也要把已经花掉的耗时记上（finally）');
    eq(P.measure('bad', '不是一個函数'), null, '误用 measure 返回 null 而不是抛');
    eq(P.summary().metrics.bad, undefined, '误用不留账：探针的失败必须是静默的');
  }

  section('count 与 topByTotal');
  {
    const { P } = loadProbe();
    eq(P.count('frames'), 1, '不给增量就是「发生一次」');
    eq(P.count('frames'), 2, '同名计数器累加');
    eq(P.count('bytes', 512), 512, '给数字就按数字加');
    eq(P.count('bytes', NaN), 513, '非有限增量按一次算：NaN 进账会让这个计数器以后永远读不出有意义的值');
    eq(P.count('release', 3), 3, '先加三次');
    eq(P.count('release', -1), 2, '允许减：借还型计数器需要 release 语义');
    const c = P.summary().counters;
    eq(c.frames, 2, 'counters 出现在 summary 里');
    eq(c.bytes, 513, '快照包含 512 增量与随后按一次记入的 NaN 增量');
    c.frames = 999;
    eq(P.summary().counters.frames, 2, 'summary 给的是读数副本，不是活引用：改它不许动账本');
  }
  {
    const { P } = loadProbe();
    P.mark('fast', 5);
    P.mark('slow', 50);
    P.mark('mid', 20);
    P.mark('slow', 5);
    const top = P.topByTotal ? P.topByTotal() : P.summary().topByTotal;
    eq(top.map((e) => e.name).join(','), 'slow,mid,fast',
      'topByTotal 按累计耗时从大到小（榜的意义是「先看哪一笔」）');
    eq(top[0].totalMs, 55, '第一名是累计最多那笔，不是最新那笔');
    eq(top[0].count, 2, '榜里带笔数');
    eq(Object.keys(top[0]).sort().join(','), 'avgMs,count,lastMs,maxMs,name,totalMs',
      '榜条目的字段是固定这六个');
    const again = P.summary().topByTotal;
    eq(again.map((e) => e.name).join(','), 'slow,mid,fast', '排序不改动账本：再取一次顺序一致');
    eq(Object.keys(P.summary().metrics).join(','), 'fast,slow,mid',
      'summary.metrics 保持入账顺序（排序发生在副本上）');
    again[0].totalMs = 1;
    eq(P.summary().topByTotal[0].totalMs, 55, '榜条目是副本：改它不许动账本');
  }
  {
    const { P } = loadProbe();
    for (let i = 0; i < 30; i += 1) P.mark('m' + i, i + 1);
    const top = P.summary().topByTotal;
    eq(top.length, P.limits.topMetrics, '榜单有上限（' + P.limits.topMetrics + ' 条），不是全量导出');
    eq(top[0].name, 'm29', '最长的那笔在榜首');
    const cut = new Set(top.map((e) => e.name));
    ok(!cut.has('m0') && !cut.has('m5'), '被砍掉的是累计最小的那些');
    eq(Object.keys(P.summary().metrics).length, 30, '砍榜不许砍账：完整账本仍在 metrics 里');
  }

  section('指标名不许碰到原型链');
  {
    const { P } = loadProbe();
    P.mark('__proto__', 5);
    P.mark('constructor', 3);
    P.mark('toString', 2);
    P.count('__proto__', 7);
    const s = P.summary();
    eq(Object.keys(s.metrics).length, 3, '三个原型名各自是一条真条目');
    eq(s.metrics.__proto__.totalMs, 5, '按 __proto__ 取回的是那笔账，不是 Object.prototype');
    eq(s.counters.__proto__, 7, '计数器同理');
    ok(Object.prototype.hasOwnProperty.call(s.counters, '__proto__'),
      '键名 __proto__ 落在对象自己身上（否则那条账会静默变成别人的原型）');
    eq(JSON.parse(JSON.stringify(s)).metrics.__proto__.count, 1, '序列化后仍然读得回来');
  }

  section('时间来源与装载');
  {
    const { P, clock } = loadProbe({ clock: 'date', start: 2000 });
    eq(P.now(), 2000, '没有 performance 时退到 Date.now（插件形态里前者不一定在）');
    clock.value += 500;
    eq(P.summary().uptimeMs, 500, 'uptime 用同一个时间来源，混用会算出负数');
    eq(P.markSince('w', 2000).totalMs, 500, '窗口计算也走降级来源');
  }
  {
    const noWindow = loadProbe({ noWindow: true });
    ok(noWindow.P, '没有 window 时挂到全局对象上，不抛');
  }
  {
    const first = loadProbe();
    first.P.mark('keep', 12);
    first.P.count('keep', 3);
    const before = first.P.summary().metrics.keep.totalMs;
    // 同一份脚本被挂第二遍（重复注入 / 热重载）：账不能清零，否则「开机头 30 秒
    // 慢在哪」正好在装载动作之后消失。
    vm.runInContext(read(PROBE_REL), first.ctx);
    eq(first.ctx.HertzPerf.state.metrics.keep.totalMs, before, '重复求值不清账');
    eq(first.ctx.HertzPerf.state.metrics.keep.count, 1, '重复求值不重复记账');
    eq(first.ctx.HertzPerf.count('keep'), 4, '计数器也不重置');
    const second = loadProbe();
    second.P.mark('keep', 1);
    eq(second.P.summary().metrics.keep.count, 1, '另一个沙箱是全新的账（没有跨页共享状态）');
  }

  section('snapshot：接我们已有的统计来源');
  {
    const panels = fakePanels();
    const { P, ctx } = loadProbe();
    Object.assign(ctx, panels);
    const snap = P.snapshot();
    eq(snap.sourceCount, 4, '四个面板都在场');
    eq(Object.keys(snap.sources).sort().join(','), 'backgrounds,creative,stage,stage3d',
      '快照按面板 id 汇总');
    eq(snap.sources.stage.displayHz, 119.88, 'Stage 的实测刷新率取到了（只四舍五入，不改名）');
    eq(snap.sources.stage.gates[0].name, 'particles', '帧门换算整块透传：声明档位 vs 实测 runs/s');
    eq(snap.sources.stage.tier, 1, '设备档位进快照');
    eq(snap.sources.stage.lowFx, false, '降级态进快照（否则看不出这组数是降档后跑的）');
    eq(Object.keys(snap.sources.stage3d).sort().join(','),
      'costMs,divisor,dpr,fps,hz,pressure,quality',
      'Stage3D 只拿耗时与分频：音频/相机/时间是内容，不是性能口径');
    ok(!('audio' in snap.sources.stage3d) && !('camera' in snap.sources.stage3d)
      && !('buffer' in snap.sources.stage3d) && !('stage' in snap.sources.stage3d)
      && !('time' in snap.sources.stage3d),
      '被排除的字段一个都不许混进来');
    eq(Object.keys(snap.sources.creative).sort().join(','),
      'animations,dprScale,fps,probe,tier', '编排层只拿帧率/DPR/探测结论');
    eq(snap.sources.creative.probe.rounds, 4, 'DPR 代价探测的结论整块可见（糊了要能追责）');
    eq(Object.keys(snap.sources.backgrounds).sort().join(','), 'fps,size,wallTex',
      '背景层拿目标帧率与作画/纹理尺寸');
    ok(!snap.sourceErrors, '一切正常时不该有错误栏');
  }
  {
    // 三种坏来源：缺席 / 抛 / 返回非对象。共同底线是 snapshot() 不抛。
    const cases = [
      { name: '面板整个缺席', patch: { Stage3D: null }, absent: 'stage3d', errors: 0 },
      { name: '面板在场但没实现 stats()', patch: { Stage3D: { version: 1 } }, absent: 'stage3d', errors: 0 },
      { name: '面板 stats() 抛了', patch: { Stage3D: { stats: () => { throw new Error('面板炸了'); } } }, absent: 'stage3d', errors: 1 },
      { name: 'stats() 返回 null', patch: { Stage3D: { stats: () => null } }, absent: 'stage3d', errors: 0 },
      { name: 'stats() 返回数字', patch: { Stage3D: { stats: () => 5 } }, absent: 'stage3d', errors: 0 },
      { name: 'stats() 返回空对象', patch: { Stage3D: { stats: () => ({}) } }, absent: 'stage3d', errors: 0 },
      { name: 'Stage 没有可读性能方法', patch: { Stage: {} }, absent: 'stage', errors: 0 }
    ];
    cases.forEach((tc) => {
      const { P, ctx } = loadProbe();
      Object.assign(ctx, fakePanels(tc.patch));
      let snap = null;
      let threw = null;
      try { snap = P.snapshot(); } catch (e) { threw = e.message; }
      ok(threw === null, tc.name + '：snapshot() 不许抛');
      if (threw !== null) return;
      eq(snap.sources[tc.absent], undefined, tc.name + '：这块缺席');
      eq(Object.keys(snap.sourceErrors || {}).length, tc.errors,
        tc.name + '：只有真的抛异常才留痕（缺席与坏了必须可区分）');
      if (tc.errors) eq(snap.sourceErrors[tc.absent], 'stats_unavailable',
        tc.name + '：固定错误码区分故障，不携带可能含曲目内容的异常文本');
      eq(typeof snap.topByTotal, 'object', tc.name + '：探针自己的部分照常可用');
    });
  }
  {
    // 部分字段缺失：有什么给什么，缺的不补 0 —— 补出来的 0 会被当成实测值。
    const { P, ctx } = loadProbe();
    ctx.Stage3D = { stats: () => ({ fps: 24, costMs: 9.5, stage: 'x' }) };
    const snap = P.snapshot();
    eq(Object.keys(snap.sources.stage3d).sort().join(','), 'costMs,fps',
      '只给面板真有的那两个字段');
    ok(!('divisor' in snap.sources.stage3d), '缺失字段不许补默认值');
    ctx.Stage = { tier: () => 0 };
    eq(JSON.stringify(P.snapshot().sources.stage), '{"tier":0}', 'Stage 部分字段缺失同样保留已有读数');
  }
  {
    const { P, ctx } = loadProbe();
    const gates = [{ name: 'particles', target: 30, divisor: 2, achieved: 30, track: 'private title' }];
    const probe = { loss: 0.12, rounds: 4, running: false, track: 'private title' };
    ctx.Stage = { gateRates: () => gates };
    ctx.CreativeStage = { stats: () => ({ fps: 30, probe }) };
    ctx.Stage3D = { stats: () => { throw new Error('private title'); } };
    const snap = P.snapshot();
    ok(!JSON.stringify(snap).includes('private title'), '嵌套来源与异常同样受性能白名单约束');
    gates[0].target = 10;
    probe.rounds = 9;
    eq(snap.sources.stage.gates[0].target, 30, '帧门快照不随来源对象变化');
    eq(snap.sources.creative.probe.rounds, 4, 'DPR 探测快照不随来源对象变化');
    snap.sources.stage.gates[0].target = 5;
    snap.sources.creative.probe.rounds = 1;
    eq(gates[0].target, 10, '修改帧门快照不能改来源');
    eq(probe.rounds, 9, '修改探测快照不能改来源');
  }

  section('真实帧门采样：只记实际执行，不改变停机、分频与异常');
  {
    const { P, ctx, clock } = loadProbe();
    const stage = read('plugin/ui/stage.js');
    ctx.gates = [];
    ctx.gateDivisor = (target) => Math.ceil(60 / target);
    vm.runInContext('function runGates(dt) ' + blockAfter(stage, 'function runGates('), ctx);
    let frames = 0;
    ctx.gates.push({ name: 'render', fpsFn: () => 30, tickFn: () => { frames++; clock.value += 2; }, skip: 0, wait: 0 });
    ctx.gates.push({ name: 'idle', fpsFn: () => 0, tickFn: () => { throw new Error('idle ran'); }, skip: 0, wait: 0 });
    for (let i = 0; i < 120; i++) ctx.runGates(1000 / 60);
    const metric = P.summary().metrics['gate.render'];
    eq(frames, 60, '120 个 60Hz 帧只执行 60 次 30fps 渲染');
    eq(metric && metric.count, 60, '账本计数与真实执行次数一致');
    eq(metric && metric.totalMs, 120, '账本耗时来自真实回调窗口');
    eq(P.summary().metrics['gate.idle'], undefined, '停机门不产生假样本');
    P.setEnabled(false);
    ctx.runGates(1000 / 60); ctx.runGates(1000 / 60);
    eq(frames, 61, '探针关闭仍执行渲染');
    eq(P.summary().metrics['gate.render']?.count, 60, '探针关闭不增加样本');
    P.setEnabled(true);
    ctx.gates = [{ name: 'throw', fpsFn: () => 60, tickFn: () => { clock.value += 3; throw new Error('render error'); }, skip: 0, wait: 0 }];
    let error;
    try { ctx.runGates(1000 / 60); } catch (e) { error = e.message; }
    eq(error, 'render error', '渲染异常保持原传播语义');
    eq(P.summary().metrics['gate.throw']?.totalMs, 3, '异常路径已花费的时间仍入账');
    delete ctx.HertzPerf;
    ctx.gates = [{ name: 'absent', fpsFn: () => 60, tickFn: () => { frames++; }, skip: 0, wait: 0 }];
    ctx.runGates(1000 / 60);
    eq(frames, 62, '探针未加载时渲染照常执行');
  }
  {
    // 取快照不记账：探针自己必须是透明的。
    const { P, ctx } = loadProbe();
    Object.assign(ctx, fakePanels());
    P.mark('a', 3);
    P.count('c1');
    const before = JSON.stringify(P.summary());
    P.snapshot();
    P.snapshot();
    eq(JSON.stringify(P.summary()), before, '连续两次 snapshot 之后，账一模一样');
    const s1 = P.snapshot();
    P.mark('a', 4);
    eq(s1.metrics.a.count, 1, '旧快照是读数，不是活引用');
    eq(s1.metrics.a.totalMs, 3, '旧快照的数字不许被后续 mark 改写');
    eq(P.snapshot().metrics.a.count, 2, '新快照读到新账');
    const g1 = P.snapshot().sources.stage.gates;
    let calls = 0;
    ctx.Stage.gateRates = () => { calls += 1; return g1; };
    P.snapshot();
    eq(calls, 1, '每次快照各读一次来源（既不缓存成活引用，也不重复读）');
  }

  section('真实主循环时钟：续帧不重置间隔，子系统耗时不污染刷新率');
  {
    const stage = read('plugin/ui/stage.js');
    let time = 1000, callback = null, nextId = 0;
    const seen = [];
    const ctx = {
      rafId: 0, lastFrameAt: 0, lastDt: 0, hidden: false, playing: true, energy: 0,
      now: () => time, clamp: (x, a, b) => Math.max(a, Math.min(b, x)),
      runGates: () => {}, sampleDisplayHz: dt => seen.push(dt), sampleFrameRate: () => {},
      anyGateWants: () => false,
      requestAnimationFrame: fn => { ok(!callback, '主循环始终只有一个待执行回调'); callback = fn; return ++nextId; },
      cancelAnimationFrame: () => { callback = null; }, fps: { since: 0 }
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const [name, args] of [['frame', ''], ['schedule', ''], ['setHidden', 'v']]) {
      vm.runInContext('function ' + name + '(' + args + ') ' + blockAfter(stage, 'function ' + name + '('), ctx);
    }
    const tick = gap => { time += gap; const fn = callback; callback = null; fn(); };
    ctx.schedule();
    tick(1000 / 120); tick(1000 / 120);
    ok(Math.abs(seen[1] - 1000 / 120) < 0.001, '120Hz 续帧向估计器提供实际 8.33ms');
    ctx.runGates = () => { ctx.lastDt = 80; };
    tick(1000 / 120);
    ok(Math.abs(seen[2] - 1000 / 120) < 0.001, '歌词累积间隔不能污染显示刷新率估计');
    ctx.runGates = () => {};
    ctx.playing = false;
    tick(1000 / 120);
    eq(callback, null, '没有需求后主循环真正停止');
    time += 5000;
    ctx.schedule(); tick(1000 / 120);
    eq(seen[4], 16.7, '停机后恢复的首帧不把五秒空闲记入间隔');
    ctx.playing = true;
    ctx.schedule(); tick(1000 / 120);
    ctx.setHidden(true);
    eq(callback, null, '隐藏页取消排期');
    time += 5000;
    ctx.setHidden(false); tick(1000 / 120);
    eq(seen[6], 16.7, '隐藏后恢复也重置首帧基准');
  }

  section('白名单必须对得上真实 stats()（不许发明字段）');
  {
    const src = read(PROBE_REL);
    const claims = pickLists(src);
    eq(claims.length, 3, '探针里声明了三份 pickFields 白名单');
    const targets = [
      { rel: 'plugin/ui/stage3d.js', marker: 'stats: function () {', want: ['fps', 'hz', 'costMs', 'pressure', 'divisor', 'quality', 'dpr'] },
      { rel: 'plugin/ui/creative-stage.js', marker: 'stats: function () {', want: ['fps', 'tier', 'dprScale', 'animations', 'probe'] },
      { rel: 'plugin/ui/backgrounds.js', marker: 'stats: function () {', want: ['fps', 'size', 'wallTex'] }
    ];
    const claimedNames = claims.map((l) => l.slice().sort().join(','));
    targets.forEach((t, i) => {
      const real = statsKeys(t.rel, t.marker);
      ok(Array.isArray(real), t.rel + ' 的 stats() 字段抓得到');
      if (!real) return;
      const want = t.want.slice().sort().join(',');
      ok(claimedNames.includes(want),
        t.rel + ' 的白名单在探针源码里（' + t.want.join(',') + '）');
      const invented = t.want.filter((k) => !real.includes(k));
      eq(invented.join(','), '', t.rel + ' 不许把不存在于 stats() 的字段写进快照：' + JSON.stringify(invented));
      const drifted = t.want.filter((k) => !claims.some((l) => l.includes(k)));
      eq(drifted.join(','), '', t.rel + ' 的字段一旦改名，探针这条链必须红（而不是静默少一块）：' + JSON.stringify(drifted));
    });

    // Stage 没有 stats()，它给的是方法；逐个确认方法真在 window.Stage 上。
    const stage = read('plugin/ui/stage.js');
    ['gateRates', 'displayHz', 'tier', 'isLowFx'].forEach((fn) => {
      ok(new RegExp('\\n\\s{4}' + fn + ': function \\(').test(stage),
        'stage.js 的 window.Stage 暴露了 ' + fn + '()');
    });
    ok(/Stage3D|CreativeStage|Backgrounds/.test(src) === true,
      '来源表按 window 上的全局名寻址（面板改名会在这里红）');

    // 没接的面板留在没接的状态：接不上的字段宁可不写。
    const owners = (src.match(/owner:\s*'([^']+)'/g) || [])
      .map((s) => /'([^']+)'/.exec(s)[1]);
    eq(owners.sort().join(','), 'Backgrounds,CreativeStage,Stage,Stage3D',
      '来源表只有这四个全局：StageParticles/HandDrawn 的 stats() 里只有一个 fps，本批不接');
    ok(!/Stanza[A-Za-z]*|StageSubtitle/.test(src),
      'stanza/* 没有性能口径（那里的 stats 是逐行文本统计），探针不许冒充接了它');
  }

  section('调用点守卫：探针缺席不许打断被测路径');
  {
    // 扫描器自己先被正反样例验一遍，否则这一节只是「看起来在检查」。
    eq(guardViolations('HertzPerf.mark("a", 1);').length, 1, '扫描器要能抓到裸调用');
    eq(guardViolations('if (typeof HertzPerf !== "undefined") HertzPerf.mark("a", 1);').length, 0,
      'typeof 守卫在同一行算合法');
    eq(guardViolations('window.HertzPerf && HertzPerf.count("x");').length, 0,
      '&& 守卫在同一行算合法');
    eq(guardViolations('HertzPerf?.mark("a", 1);').length, 0, '可选链算合法');
    eq(guardViolations('// HertzPerf.snapshot() 的用法说明').length, 0, '注释不算调用点');
    const fixtures = guardViolations('x = 1;');
    eq(fixtures.length, 0, '没提探针的行不算违规');

    const bare = [];
    uiSourceFiles().forEach((rel) => {
      if (rel === PROBE_REL) return;
      guardViolations(read(rel)).forEach((line) => bare.push(rel + ':' + line));
    });
    eq(bare.join(', '), '', 'plugin/ui 里所有探针调用点都必须自带守卫（缺席时静默跳过）');
  }

  section('资源注册：目录统一挂载与指纹，插件打包同一份 UI');
  {
    const html = read('plugin/ui/index.html');
    const resource = require('./ui-assets').readAssets().find(a => a.path === '/perf-probe.js');
    ok(resource && resource.name === 'PERF_PROBE_JS' && resource.mime === 'JS', '探针登记了正确路径、文件与 MIME');
    ok(resource && resource.file.endsWith('perf-probe.js'), '探针路由返回自己的实现');
    const at = html.indexOf('src="perf-probe.js"');
    ok(at >= 0 && at < html.indexOf('src="app.js"'), '探针在 app.js 前加载');
    ok(at >= 0 && at < html.indexOf('src="stage.js"'), '探针在帧门前加载');
    ok(/include\s*=\s*\[[^\]]*"ui"/.test(read('plugin/dbx-plugin.toml')), '插件包包含 ui 目录（sidecar 不负责静态资源）');
    eq(JSON.parse(read('plugin/manifest.json')).entrypoints.ui.entry, 'ui/index.html', '插件入口复用已接线的 index.html');
  }

  console.log('\n跨模块性能探针契约检查：' + checks + ' 项'
    + (failures ? '，' + failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
}());
