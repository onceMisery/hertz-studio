// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 跨模块性能探针：全局那份共同账本（mark / markSince / count / topByTotal）。
//
// 为什么要这一个文件：各面板早就有自己的读数（`Stage.gateRates()`、
// `Stage3D.stats()`、`CreativeStage.stats()`、`Backgrounds.stats()`），但那是一
// 份份各自解释的数字 —— 「这一帧慢在谁身上」「哪个环节累计最多」跨模块没有
// 共同的账本，只能靠猜。这里补的只有那一件事：记账、聚合、取快照。
//
// 三条边界，都是「探针不许改变被测量的行为」这条的具体形状：
//
//   1. 探针不在场时什么都不会发生。调用点一律带 typeof 守卫；快照里少一个源
//      就少一个源，不抛、不重试、不排期、不自己造一个 0 —— 凭空多出来的 0 会
//      被当成实测值读，比缺数更坏。
//   2. 快照字段只从那些 `stats()` 里**已经存在**的键里挑，名字与形状归原面板
//      维护。这里不改名、不补默认值，所以面板改了字段名，这条链是断在检查里
//      而不是断在运行时。
//   3. 取快照本身不记账，返回的是读数而不是活引用：连续两次 `snapshot()` 的账
//      必须一模一样，否则探针自己就成了被测噪声的一部分。
//
// 零依赖：只读 `performance.now`（没有就退到 `Date.now`）与 window 上的已有
// 全局，没有 DOM、没有存储、没有网络。

(function (global) {
  'use strict';

  var PROBE_VERSION = 'hertz-global-metrics-1';
  // 每笔指标只留最近这么多个样本：样本是给人看形状用的（这串耗时是抖还是尖），
  // 不是全量记录。全量留在页面上跑几个小时之后会先撑爆内存。
  var MAX_SAMPLES_PER_METRIC = 90;
  var SAMPLE_TAIL = 18;
  // topByTotal 的条数上限：榜是给「先看哪三笔」用的，不是导出用的。
  var MAX_TOP_METRICS = 24;

  function readNow() {
    return (typeof performance !== 'undefined' && performance && performance.now)
      ? performance.now()
      : Date.now();
  }

  // 账本用无原型对象：指标名是调用方给的任意字符串，`mark('__proto__', 5)`
  // 这类不许把账记到原型链上去（记上去之后 every/hasOwnProperty 都会看见假条目）。
  function emptyMap() {
    return Object.create(null);
  }

  function roundNumber(value, digits) {
    var scale = Math.pow(10, digits || 0);
    return Math.round((Number(value) || 0) * scale) / scale;
  }

  // 同样用无原型对象：这两处的键就是指标名/计数器名，`{}` 会让 `__proto__`
  // 这个键在赋值时改掉返回对象的原型而不是留下一条条目 —— 那条账就静默消失了。
  function clonePlainMap(map) {
    var out = emptyMap();
    Object.keys(map || {}).forEach(function (key) {
      out[key] = map[key];
    });
    return out;
  }

  // 耗时只接受「有限的非负数」：NaN（调用方算了个空对象）、Infinity、负数
  // （时钟往回走过）一律不入账。少一道这个闸，一笔脏数据就能把 totalMs 变成
  // NaN，然后整张榜永远为空。
  function costOf(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0 ? value : null;
  }

  var state = {
    version: PROBE_VERSION,
    enabled: true,
    startedAt: readNow(),
    lastResetAt: readNow(),
    metrics: emptyMap(),
    counters: emptyMap()
  };

  function metricFor(name) {
    var key = String(name || 'unknown');
    if (!state.metrics[key]) {
      state.metrics[key] = {
        name: key,
        count: 0,
        totalMs: 0,
        avgMs: 0,
        maxMs: 0,
        lastMs: 0,
        samples: []
      };
    }
    return state.metrics[key];
  }

  function mark(name, costMs) {
    if (!state.enabled) return null;
    var cost = costOf(costMs);
    if (cost === null) return null;
    var metric = metricFor(name);
    metric.count += 1;
    metric.totalMs += cost;
    metric.lastMs = cost;
    if (cost > metric.maxMs) metric.maxMs = cost;
    metric.avgMs = metric.totalMs / Math.max(1, metric.count);
    metric.samples.push(roundNumber(cost, 3));
    if (metric.samples.length > MAX_SAMPLES_PER_METRIC) metric.samples.shift();
    return metric;
  }

  function markSince(name, start) {
    // 参考实现写的是 `Number(start || 0)`：起点漏传时拿 0 当起点，等于记下一笔
    // 「从开机到现在」的耗时。那个区间没人测过，而它几乎必然排第一，榜就废了。
    // 所以这里起点不是有限数就当这次没发生。
    if (costOf(start) === null) return null;
    return mark(name, readNow() - start);
  }

  function begin(name) {
    var start = readNow();
    return function finishMetric() {
      return markSince(name, start);
    };
  }

  function measure(name, fn) {
    // 探针的失败必须是静默的：这里对误用返回 null 而不是抛，否则「没接上探针」
    // 会升级成「接了探针的那条路径直接故障」。真正的用法错误由检查脚本来抓。
    if (typeof fn !== 'function') return null;
    var start = readNow();
    try {
      return fn();
    } finally {
      markSince(name, start);
    }
  }

  function count(name, amount) {
    if (!state.enabled) return 0;
    var key = String(name || 'unknown');
    var delta = Number(amount);
    // 不给参数就是「发生了一次」；给了但不是数就同样按一次算，
    // 否则一次调用计数为 NaN，这个计数器以后永远读不出有意义的值。
    if (!isFinite(delta)) delta = 1;
    state.counters[key] = (state.counters[key] || 0) + delta;
    return state.counters[key];
  }

  function metricSummary(metric) {
    return {
      count: metric.count,
      totalMs: roundNumber(metric.totalMs, 3),
      avgMs: roundNumber(metric.avgMs, 3),
      maxMs: roundNumber(metric.maxMs, 3),
      lastMs: roundNumber(metric.lastMs, 3),
      samples: metric.samples.slice(-SAMPLE_TAIL)
    };
  }

  // 按累计耗时排名。先 map 出快照再排序：原地排 state.metrics 里的对象会把
  // 「谁最后被 mark 过」这个信息冲进排序里，账本顺序不该是探针的输出。
  function metricsByTotal(limit) {
    return Object.keys(state.metrics)
      .map(function (key) { return state.metrics[key]; })
      .sort(function (a, b) { return b.totalMs - a.totalMs; })
      .slice(0, limit || MAX_TOP_METRICS)
      .map(function (metric) {
        return {
          name: metric.name,
          count: metric.count,
          totalMs: roundNumber(metric.totalMs, 3),
          avgMs: roundNumber(metric.avgMs, 3),
          maxMs: roundNumber(metric.maxMs, 3),
          lastMs: roundNumber(metric.lastMs, 3)
        };
      });
  }

  function summary() {
    var metrics = emptyMap();
    Object.keys(state.metrics).forEach(function (key) {
      metrics[key] = metricSummary(state.metrics[key]);
    });
    return {
      version: state.version,
      enabled: state.enabled,
      uptimeMs: roundNumber(readNow() - state.startedAt, 1),
      sinceResetMs: roundNumber(readNow() - state.lastResetAt, 1),
      counters: clonePlainMap(state.counters),
      topByTotal: metricsByTotal(MAX_TOP_METRICS),
      metrics: metrics
    };
  }

  // 嵌套读数也按白名单复制，不能把来源的活对象（或未来新增的内容字段）透传。
  var PROBE_FIELDS = ['loss', 'base', 'on', 'rounds', 'dprScale', 'step',
    'pending', 'running', 'skipped', 'muted'];
  var GATE_FIELDS = ['name', 'target', 'divisor', 'achieved'];

  function pickValues(raw, names) {
    if (!raw || typeof raw !== 'object') return null;
    var out = {};
    var taken = 0;
    names.forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) return;
      var value = raw[key];
      if (key === 'probe') value = pickValues(value, PROBE_FIELDS);
      else if (value !== null && typeof value !== 'string' && typeof value !== 'boolean'
        && !(typeof value === 'number' && isFinite(value))) return;
      out[key] = value;
      taken += 1;
    });
    return taken ? out : null;
  }

  // 只从 stats() 已有的键里挑性能相关的那几个。白名单写死在这里是有意的：
  // 面板加了字段不该自动涌进全局快照（那会把「有什么」变成「猜有什么」）。
  function pickFields(names) {
    return function (api) {
      if (typeof api.stats !== 'function') return null;
      return pickValues(api.stats(), names);
    };
  }

  // 已知来源表。id 是快照里的键，owner 是那个全局的名字。
  var SOURCES = [
    {
      id: 'stage',
      owner: 'Stage',
      // Stage 没有 stats()：这里读预算在实测刷新率下的换算，不冒充已执行次数。
      // 实际 runs/s 由两次快照 gate.* 的 count 差 / sinceResetMs 差计算。
      read: function (api) {
        var out = {};
        var taken = 0;
        if (typeof api.gateRates === 'function') {
          out.gates = api.gateRates().map(function (gate) { return pickValues(gate, GATE_FIELDS); });
          taken += 1;
        }
        if (typeof api.displayHz === 'function') { out.displayHz = roundNumber(api.displayHz(), 2); taken += 1; }
        if (typeof api.tier === 'function') { out.tier = api.tier(); taken += 1; }
        if (typeof api.isLowFx === 'function') { out.lowFx = !!api.isLowFx(); taken += 1; }
        return taken ? out : null;
      }
    },
    {
      id: 'stage3d',
      owner: 'Stage3D',
      // 只拿耗时与分频这几笔；音频、相机、时间是内容，不是性能口径。
      read: pickFields(['fps', 'hz', 'costMs', 'pressure', 'divisor', 'quality', 'dpr'])
    },
    {
      id: 'creative',
      owner: 'CreativeStage',
      // probe 是那层自己的 DPR 代价探测结论：它改的是用户没碰过的东西，
      // 所以必须在全局账本里看得见，否则「画面为什么糊了」又一次无人认领。
      read: pickFields(['fps', 'tier', 'dprScale', 'animations', 'probe'])
    },
    {
      id: 'backgrounds',
      owner: 'Backgrounds',
      // size / wallTex 是这层的实际作画分辨率与纹理尺寸 —— 背景是「画得很小
      // 让合成器放大」那一层，光看 fps 看不出它花了多少。
      read: pickFields(['fps', 'size', 'wallTex'])
    }
  ];

  function collectSources() {
    var sources = {};
    var errors = {};
    SOURCES.forEach(function (src) {
      var api = global[src.owner];
      // 面板不在场（这个形态没挂它、或还没加载）：这块直接缺席，不报错也不补数。
      if (!api || typeof api !== 'object') return;
      var data = null;
      try {
        data = src.read(api);
      } catch (e) {
        // 面板自己抛了要留痕：否则「这块没数据」和「这块坏了」在快照里长一样。
        errors[src.id] = 'stats_unavailable';
        return;
      }
      if (!data) return;
      sources[src.id] = data;
    });
    return { sources: sources, errors: errors };
  }

  function snapshot() {
    var snap = summary();
    var read = collectSources();
    snap.sources = read.sources;
    snap.sourceCount = Object.keys(read.sources).length;
    if (Object.keys(read.errors).length) snap.sourceErrors = read.errors;
    return snap;
  }

  function reset() {
    state.metrics = emptyMap();
    state.counters = emptyMap();
    state.lastResetAt = readNow();
    return summary();
  }

  function setEnabled(on) {
    state.enabled = !!on;
    return state.enabled;
  }

  var api = {
    version: PROBE_VERSION,
    state: state,
    now: readNow,
    mark: mark,
    markSince: markSince,
    begin: begin,
    measure: measure,
    count: count,
    // 榜单单独开口：控制台里想看「现在谁最贵」不该逼先把整个 summary 打出来
    // （那会顺带复制上百条 metrics，而那是一次本不该有的分配）。
    topByTotal: metricsByTotal,
    summary: summary,
    snapshot: snapshot,
    reset: reset,
    setEnabled: setEnabled,
    limits: {
      samplesPerMetric: MAX_SAMPLES_PER_METRIC,
      sampleTail: SAMPLE_TAIL,
      topMetrics: MAX_TOP_METRICS
    }
  };

  // 同一版本重复求值（脚本被挂了两遍、或热重载）不该抹掉已积累的账：那会让
  // 「开机头 30 秒慢在哪」这类问题正好在装载动作之后消失。
  if (global.HertzPerf && global.HertzPerf.version === PROBE_VERSION) return;

  global.HertzPerf = api;
}(typeof window !== 'undefined' ? window : this));
