#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 每轨运行时音质上限的接线契约检查（零依赖、不触网）。
//
//   node scripts/check-quality-ceiling.js
//
// 治的是借鉴清单 §2 B4 那一条：「降档对用户可见，且不会又弹回高档」。上限的
// 算法与真实重试入口由 Rust 单元测试覆盖；这里补充跨模块接线检查，防止某条
// 路径绕过上限，或把变化后的偏好误当成失败时的实际档位。静态检查不替代行为测试。
//
// 所以这里钉的是接线与命名，五件事：
//
//   1. 取档只有一个入口：播放、预取、解码收口、节拍分析找缓存文件，四处都必须
//      走 online_quality_for。裸读偏好的话，被夹低的那首会在某一处又去要高档
//      （节拍分析那处尤其阴：文件挂在夹后的档位下，按原始偏好找就永远找不到，
//      节拍分析静默不跑，舞台只表现为「这首歌没有镜头变化」）。
//   2. 取流重试只记一次不可变尝试档位；最终失败只接收未记账的实际档位。
//      解码错误必须消费匹配播放/actor 代际的提交证据，不能再读取当前偏好猜档。
//   3. 服务端事件名与前端分发名必须对得上。serde 的 rename_all = "snake_case"
//      把 QualityDowngraded 发成 quality_downgraded，app.js 少一个 case 就是
//      整条提示静默丢失——不报错、不塌界面，只是从来没人见过降档说明。
//   4. 提示措辞得带上从高到低两档，否则用户只看到「音质降了」不知道降到哪。
//   5. 前端那层的一次性抑制不许回来：原来用 window.__qtoast 一个布尔，第一次
//      提示之后整页都静默，第二首被降档的歌就又变成「听着不太对」。去重必须
//      按「这一首 + 这一档」，这部分下面直接执行真实模块里的函数来验。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'crates', 'hertz-studio', 'src', 'state.rs');
const BEATS = path.join(ROOT, 'crates', 'hertz-studio', 'src', 'stage_beats.rs');
const ONLINE = path.join(ROOT, 'plugin', 'ui', 'online.js');
const APP = path.join(ROOT, 'plugin', 'ui', 'app.js');

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
function read(file) { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); }

/// 生产代码部分：单元测试整段挂在 `#[cfg(test)]` 之后，算接线时必须摘掉，
/// 否则测试里那些合法的直接调用会被数成接线点。
function shipped(src) {
  const at = src.indexOf('#[cfg(test)]');
  return at < 0 ? src : src.slice(0, at);
}

function count(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/// 从源码里按名字抠出一个完整函数（花括号配平），原样执行。仓库里其余契约
/// 脚本用同一招：改了实现，这里跟着一起变，不另写一份影子实现。
function grabFn(src, head) {
  const at = src.indexOf(head);
  if (at < 0) throw new Error('抠不到 ' + head);
  const i = src.indexOf('{', at);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(at, j + 1);
    }
  }
  throw new Error(head + ' 花括号不配平');
}

(function main() {
  section('取档入口：四处都得走夹上限的那一个');
  {
    const state = shipped(read(STATE));
    const beats = shipped(read(BEATS));
    // 计数只作补充；真实入口也要分别检查，新增其他调用不能掩盖一个关键入口漏接。
    const uses = count(state, 'online_quality_for(');
    ok(uses >= 5, `state.rs 里 online_quality_for 的调用/定义共 ${uses} 处，少于 5 处（有一处取档没夹上限）`);
    // 裸读偏好的写法只许留在 online_quality_for 内部与设置页的档位描述里。
    const rawReads = count(state, 'crate::online::quality::get(&prefs');
    ok(rawReads <= 1, `state.rs 生产代码里裸读 quality::get(&prefs 出现 ${rawReads} 次，应当只剩 helper 内那 1 次`);
    ok(count(beats, 'online_quality_for(') === 1,
      'stage_beats.rs 的在线曲缓存查找要走夹上限的档位（否则被降档那首永远找不到文件）');
    ok(!/crate::online::quality::get\(&prefs/.test(beats),
      'stage_beats.rs 不许再按原始偏好拼档位');
    for (const head of ['async fn play_online(', 'async fn spawn_prefetch(', 'async fn handle_decode_failure(']) {
      ok(/online_quality_for\(/.test(grabFn(state, head)), `${head} 使用夹上限后的档位`);
    }
  }

  section('失败证据：固定尝试档位、匹配代际、一次记账');
  {
    const state = shipped(read(STATE));
    const note = grabFn(state, 'async fn note_quality_failure(');
    ok(/failed_at: crate::online::quality::Quality/.test(note)
      && /lower_ceiling\(caps\.get\(track_id\)\.copied\(\),\s*failed_at\)/.test(note),
    '降档 helper 必须接收并使用失败时的档位');
    ok(!/online_quality_for\(|quality::get\(|online_prefs/.test(note),
      '降档 helper 不许用此刻偏好反推过去失败的档位');
    const resolve = grabFn(state, 'async fn resolve_online_stream<');
    ok(/note_quality_failure\(track_id,\s*e\.code,\s*quality\)/.test(resolve),
      '真实取流重试使用本次传给 fetch 的档位记账');
    const guardedFailure = /play_commit\.lock\(\)\.await;\s*if !self\.attempt_alive\(gen,\s*index,\s*track_id\)\.await\s*\{\s*return Ok\(None\);/.exec(resolve);
    ok(guardedFailure && guardedFailure.index < resolve.indexOf('self.note_quality_failure('),
      '取流结果在提交锁内复核代际后才能记失败，迟到响应不改上限');
    ok(resolve.indexOf('let deadline =') < resolve.indexOf('for attempt in')
      && count(resolve, 'let deadline =') === 1
      && /timeout_at\(deadline,\s*fetch\(quality\)\)/.test(resolve),
    '两次尝试共用一个绝对 deadline，重试不能重开总预算');
    const resolved = grabFn(grabFn(state, 'async fn play_online('), 'let info = match resolved');
    ok(/online_failed\(\s*gen,\s*index,\s*track_id,\s*prev_cursor,\s*trigger,\s*None,/.test(resolved),
      '取流失败已在重试 owner 记账，最终收口传 None 避免再降一档');
    const failed = grabFn(state, 'async fn online_failed(');
    ok(/if let Some\(tier\) = failed_at\s*\{\s*self\.note_quality_failure\(&track_id,\s*e\.code,\s*tier\)/.test(failed),
      '最终失败只在收到尚未记账的实际档位时记录上限');
    const decode = grabFn(state, 'async fn handle_decode_failure(');
    ok(/take_failed_quality\(&track_id,\s*generation\)\.await/.test(decode)
      && /let failed_at = failed\.actual/.test(decode)
      && /if let Some\(tier\) = failed_at\s*\{\s*self\.note_quality_failure\(&track_id,\s*"decode_stalled",\s*tier\)/.test(decode),
    '解码失败的档位来自匹配提交证据，未知档位不制造音质判决');
    const take = grabFn(state, 'async fn take_failed_quality(');
    ok(/c\.track_id == track_id/.test(take)
      && /c\.actor_generation == actor_generation/.test(take)
      && /c\.play_generation == self\.play_generation\.load/.test(take)
      && /committed\.take\(\)/.test(take),
    '失败证据同时核对曲目与两个代际，并且只能消费一次');
    const remember = grabFn(state, 'async fn remember_committed_quality(');
    ok(/play_generation: gen/.test(remember)
      && /actor_generation: self\.audio\.snapshot\(\)\.generation/.test(remember)
      && /actual,/.test(remember), '实际档位绑定到 actor 接受播放的那次提交');
    const play = grabFn(state, 'async fn play_online(');
    ok(/try_commit_cached\(gen,\s*index,\s*&track_id,\s*&path,\s*Some\(hit_quality\)\)/.test(play),
      '缓存命中传入文件实际档位，不能传用户请求的更高档');
    ok(/remember_committed_quality\(gen,\s*&track_id,\s*actual,\s*None\)/.test(play)
      && /remember_committed_quality\(gen,\s*track_id,\s*actual,\s*Some\(path\.to_path_buf\(\)\)\)/.test(grabFn(state, 'async fn try_commit_cached(')),
    '渐进播放与缓存播放都在提交处记录实际档位');
    // 上限判定不能顺手把接力那套码表复制过来：auth_required / not_found 在接力
    // 里成立，在降档里恰恰是必须排除的两类（账号级证据归登录流程，曲下架换档无用）。
    const elig = grabFn(state, 'fn ceiling_eligible(');
    for (const code of ['auth_required', 'not_found', 'upstream_timeout', 'upstream_rejected', 'upstream_error', 'internal', 'rate_limited']) {
      ok(!elig.includes('"' + code + '"'), `ceiling_eligible 排除 ${code}（账号、曲目或通用上游失败不是档位证据）`);
    }
    for (const code of ['vip_required', 'decode_stalled']) {
      ok(elig.includes('"' + code + '"'), `ceiling_eligible 该收 ${code}`);
    }
    ok(!/relay_eligible/.test(elig), 'ceiling_eligible 不许直接复用接力的码表（两类的判据不同）');
  }

  section('事件名与前端分发必须对得上');
  {
    const state = read(STATE);
    const app = read(APP);
    ok(/QualityDowngraded\s*\{/.test(state), '服务端有 WsEvent::QualityDowngraded');
    ok(/case 'quality_downgraded'/.test(app), 'app.js 分发 quality_downgraded');
    // serde 的 rename_all = "snake_case" 决定这条边上的名字；拼错不报错，只是从来没人见过。
    const body = /case 'quality_downgraded'[\s\S]{0,600}?break;/.exec(app);
    ok(body, 'quality_downgraded 的分支体抓得到');
    if (body) {
      ok(/msg\.from_label/.test(body[0]) && /msg\.to_label/.test(body[0]),
        '提示措辞要同时带上掉下来的那档和去处的那档');
      ok(/msg\.title/.test(body[0]), '提示要说清是哪首歌（一次会话里可能连着掉好几首）');
    }
  }

  section('降档提示的去重按「这一首 + 这一档」（执行真实模块）');
  {
    const online = read(ONLINE);
    // 注释里允许提这个名字（它记的就是这条禁令的来由），代码里不许再出现：
    // 一个赋值 + 一个取反判空就是那套整页抑制的完整形状。
    ok(!/window\.__qtoast\s*=[^=]/.test(online) && !/!\s*window\.__qtoast/.test(online),
      'online.js 不许再有 window.__qtoast 这类整页一次性抑制（第一次之后全页静默）');
    const src = grabFn(online, 'function qualityNoticeOnce(');
    const ctx = { qualityNoticed: {}, qualityNoticedCount: 0 };
    vm.createContext(ctx);
    vm.runInContext(src + '\nthis.once = qualityNoticeOnce;', ctx);
    const a = 'online:netease:1|lossless';
    const b = 'online:netease:2|lossless';
    ok(ctx.once(a) === true, '第一首第一次被降档要提示');
    ok(ctx.once(a) === false, '同一首同一档反复播放不重复提示');
    ok(ctx.once(b) === true, '换一首被降档的歌必须照说（这就是 __qtoast 当年漏掉的那一半）');
    ok(ctx.once('online:netease:1|standard') === true, '同一首又掉了一格要再说一次');
    ok(ctx.once('') === false && ctx.once(null) === false, '空键不占用提示额度');
    for (let i = 0; i < 200; i += 1) ctx.once('k' + i);
    ok(ctx.once('online:netease:1|lossless') === true,
      '表被重置之后同一首可以再提示一次（重置只是防内存，不许吃掉真降档）');
  }

  console.log(`\n音质上限契约检查：${checks} 项` + (failures ? `，${failures} 项失败` : '全部通过'));
  process.exit(failures ? 1 : 0);
}());
