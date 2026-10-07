#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 节拍分析调度与状态的接线契约检查（零依赖、不触网）。
//
//   node scripts/check-beat-budget.js
//
// 对应借鉴清单 §8 的 F5：后台分析要按交互负载让路，而且「分析就绪」和「缓存
// 持久化」是两种状态。算法本体（幂等表决策、并发额度、内存表有界）都在
// `stage_beats.rs` 的单元测试里真跑过了，但那些测试**测不到三件事**：
//
//   1. 取额度的顺序。先动表再拿额度，会在表里留下一格没人真的在算的
//      `Analyzing`：后来者一看就在等，而这个等永远不会有结果 —— 表现是舞台
//      一直不出节拍镜头，日志里什么错都没有。
//   2. 额度要持到落盘之后。`spawn_blocking` 一返回就还额度，等于预算只限制了
//      「同时在解码的曲子数」，落盘那两次 await 完全不受管。
//   3. 落盘失败不许记成分析失败。这两件事的用户后果不一样（一个是「以后也有，
//      重启就没」，一个是「这首歌根本没有图」），混在一起开发者就会去查错的东西。
//
// 还钉一条双门面的老规矩：新增的结果状态必须 HTTP 与 RPC 两边同时消费，只改
// 一边就是「独立形态对、dbx 插件形态错」这种最难查的形状。

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
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
function section(name) { console.log('\n' + name); }

/// 生产代码部分：单元测试挂在 `#[cfg(test)]` 之后，算接线时要摘掉。
function shipped(src) {
  const at = src.indexOf('#[cfg(test)]');
  return at < 0 ? src : src.slice(0, at);
}

/// 从 `fn 名字` 起取到下一个顶层 `}`（按花括号配平），用于「某个函数体内」的断言。
function bodyOf(src, head) {
  const at = src.indexOf(head);
  if (at < 0) return null;
  const block = blockAfter(src, head);
  return block === null ? null : src.slice(at, src.indexOf(block) + block.length);
}

/// 从 `marker` 之后第一个 `{` 起取到配平的 `}`（含两端）。用来把「某个 match
/// 分支的体内」当成一个整体断言，比按缩进猜行数可靠。
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

(function main() {
  section('并发预算：先拿额度，再动表，额度持到落盘之后');
  {
    const src = shipped(read('crates/hertz-studio/src/stage_beats.rs'));
    const request = bodyOf(src, 'async fn request(');
    ok(request, 'request() 抓得到函数体');
    if (request) {
      const acquire = request.indexOf('acquire_permit(');
      const decide = request.indexOf('table_decide(');
      ok(acquire >= 0 && decide >= 0, 'request() 既要拿额度也要过幂等表');
      ok(acquire < decide,
        '必须先拿额度再写幂等表：反了会留下一格没人算的 Analyzing，后来者永远等');
      ok(/is_none\(\)[\s\S]{0,120}Outcome::Analyzing|return Outcome::Analyzing/.test(request),
        '拿不到额度要当场收口成 analyzing，不许排队');
      ok(/beat_volatile[\s\S]{0,200}get\(&audio\.key\)/.test(request),
        '内存里那份「算出来没落盘」的图要先查，查到就别重算也别当失败');
    }
    const spawn = bodyOf(src, 'fn spawn_blocking_analysis(');
    ok(spawn, 'spawn_blocking_analysis 抓得到');
    if (spawn) {
      ok(/_permit: tokio::sync::OwnedSemaphorePermit/.test(spawn),
        '额度必须由分析任务持有（spawn_blocking 一返回就还等于没预算）');
      ok(/read_cache|write_cache/.test(spawn) && /write_cache\([^)]*\)\.await/.test(spawn),
        '落盘 await 在同一个持额度的任务里');
    }
    // 提交路径是 try，界面路径是等：反过来就是「连切歌把 GET 挂死」或「界面等不到图」。
    const acquireFn = bodyOf(src, 'async fn acquire_permit(');
    ok(acquireFn, 'acquire_permit 抓得到');
    if (acquireFn) {
      ok(/Caller::Commit => slots\.try_acquire_owned\(\)/.test(acquireFn),
        '提交路径必须 try：拿不到就推迟，不许排队');
      ok(/Caller::Demand => tokio::time::timeout\(/.test(acquireFn),
        '界面路径要等一手，但必须有超时');
    }
  }

  section('落盘失败不等于分析失败');
  {
    const src = shipped(read('crates/hertz-studio/src/stage_beats.rs'));
    const spawn = bodyOf(src, 'fn spawn_blocking_analysis(') || '';
    const errArm = blockAfter(spawn, 'Err(e) =>');
    ok(errArm, 'write_cache 的失败分支抓得到');
    if (errArm) {
      ok(/TaskState::NotPersisted/.test(errArm), '落盘失败要记 NotPersisted');
      ok(/persisted: false/.test(errArm), '事件要如实标出没落到磁盘');
      ok(!/mark_failed/.test(errArm), '落盘失败不许记成分析失败（两种状态的用户后果不同）');
    }
    ok(/beat_volatile: Mutex::new\(BoundedMap::new\(BEAT_VOLATILE_CAP\)\)|BoundedMap::new\(BEAT_VOLATILE_CAP\)/
      .test(src + shipped(read('crates/hertz-studio/src/state.rs')) + shipped(read('crates/hertz-studio/src/bootstrap.rs'))),
      '内存表要有界（BEAT_VOLATILE_CAP）：数据目录只读的设备上否则随曲目数无限涨');
    // BeatmapReady 的 persisted 必须是必填字段：可缺席就等于又把两种状态抹平。
    const ready = bodyOf(read('crates/hertz-studio/src/state.rs'), '    BeatmapReady {');
    ok(ready, 'WsEvent::BeatmapReady 抓得到');
    if (ready) {
      ok(/persisted: bool,/.test(ready), '事件带 persisted');
      ok(!/skip_serializing_if[^\n]*\n\s*persisted/.test(ready),
        'persisted 不许是可缺席字段：省略就等于把「没落到磁盘」又变成看不见的状态');
    }
  }

  section('双门面同时消费同一个结果形状');
  {
    const http = shipped(read('crates/hertz-studio/src/routes.rs'));
    const rpc = shipped(read('crates/hertz-studio/src/rpc/playback.rs'));
    // 四条路径已共用 routes 的格式器；要求 RPC 再写一份 match 会把去重误报成漏接线。
    // 钉住真正的 owner 与每个返回表达式，不能只检查导入过函数名或在注释里提过它。
    const jsonOwner = bodyOf(http, 'pub(crate) fn beatmap_outcome_json(') || '';
    const statusOwner = bodyOf(http, 'pub(crate) fn beatmap_outcome_status(') || '';
    const readyHead = /Outcome::Ready\s*\{\s*map,\s*persisted\s*\}\s*=>/.exec(jsonOwner);
    const readyBody = readyHead ? blockAfter(jsonOwner.slice(readyHead.index + readyHead[0].length), '') : '';
    ok(!!readyBody, '唯一 JSON owner 按 map/persisted 解构 Ready');
    ok(/serde_json::to_value\(&map\)/.test(readyBody || ''), 'Ready 响应从实际分析地图序列化');
    ok(/"cached"\.into\(\),\s*(serde_json::)?Value::Bool\(persisted\)/.test(readyBody || ''),
      '共享 Ready 响应的 cached 必须来自 persisted，不许写死缓存成功');
    ok(/Outcome::Ready\s*\{\s*\.\.\s*\}\s*=>\s*StatusCode::OK/.test(statusOwner),
      '共享状态 owner 把 Ready 映射到 HTTP 200');
    ok(/Outcome::Analyzing\s*=>\s*StatusCode::ACCEPTED/.test(statusOwner)
      && /Outcome::Unavailable\([^)]*\)\s*=>\s*StatusCode::NOT_FOUND/.test(statusOwner),
      '共享状态 owner 保留 analyzing=202 与 unavailable=404');
    const httpGet = bodyOf(http, 'async fn beatmap(') || '';
    const rpcGet = bodyOf(rpc, 'async fn beatmap(') || '';
    const httpRetry = bodyOf(http, 'async fn beatmap_retry(') || '';
    const rpcRetry = bodyOf(rpc, 'async fn beatmap_retry(') || '';
    ok(/let code = beatmap_outcome_status\(&outcome\)/.test(httpGet)
      && /\(code,\s*Json\(beatmap_outcome_json\(outcome\)\)\)\.into_response\(\)/.test(httpGet),
      'HTTP 取图返回共享状态 owner 与 JSON owner 的结果');
    ok(/Reply::with_status\(\s*crate::routes::beatmap_outcome_status\(&outcome\)\.as_u16\(\),\s*crate::routes::beatmap_outcome_json\(outcome\),?\s*\)/.test(rpcGet),
      'RPC 取图返回同一共享状态与 JSON owner 的结果');
    ok(/Ok\(Json\(beatmap_outcome_json\(outcome\)\)\)/.test(httpRetry),
      'HTTP 重试以 200 返回共享 JSON owner 的结果');
    ok(/Ok\(Reply::ok\(crate::routes::beatmap_outcome_json\(outcome\)\)\)/.test(rpcRetry),
      'RPC 重试以 200 返回同一共享 JSON owner 的结果');
    ok(!/Outcome::Ready|Value::Bool\(persisted\)/.test(rpcGet + rpcRetry),
      'RPC 端不另建 Ready/cached 转换分支，避免两个 owner 再次漂移');
  }

  section('尝试上限不许被绕开');
  {
    const src = shipped(read('crates/hertz-studio/src/stage_beats.rs'));
    const decide = bodyOf(src, 'pub(crate) fn table_decide(');
    ok(decide, 'table_decide 抓得到');
    if (decide) {
      ok(/attempts_max/.test(decide), '上限是参数而不是散落的字面量');
      ok(/\*attempts >= attempts_max/.test(decide), '到上限就不再重开任务');
      ok(/\*attempts \+ 1/.test(decide), '重试要接着上次的次数数（从 0 起则上限永远碰不到）');
      ok(/Some\(TaskState::NotPersisted\) => 1/.test(decide),
        '内存图被淘汰后重开一次，而不是当作失败');
    }
  }

  console.log(`\n节拍调度契约检查：${checks} 项` + (failures ? `，${failures} 项失败` : '全部通过'));
  process.exit(failures ? 1 : 0);
}());
