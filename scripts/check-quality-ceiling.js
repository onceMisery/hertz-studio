#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 每轨运行时音质上限的接线契约检查（零依赖、不触网）。
//
//   node scripts/check-quality-ceiling.js
//
// 治的是借鉴清单 §2 B4 那一条：「降档对用户可见，且不会又弹回高档」。上限的
// 算法本体（只降不升、夹取只往下）在 Rust 单元测试里跑真实代码测过了，但那个
// 测试是**直接调用** note_quality_failure / online_quality_for 的——它测不到接
// 线：少接一个失败收口点就是「某一类失败永远不降档」，少接一个取档点就是
// 「某条路径绕开上限照旧撞高档」，两种都不报错，只表现为音质时好时坏。
//
// 所以这里钉的是接线与命名，五件事：
//
//   1. 取档只有一个入口：播放、预取、解码收口、节拍分析找缓存文件，四处都必须
//      走 online_quality_for。裸读偏好的话，被夹低的那首会在某一处又去要高档
//      （节拍分析那处尤其阴：文件挂在夹后的档位下，按原始偏好找就永远找不到，
//      节拍分析静默不跑，舞台只表现为「这首歌没有镜头变化」）。
//   2. 两个失败收口点都得记上限：online_failed（取流/下载/提交失败）与
//      handle_decode_failure（解码线程半路夭夭）。
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
function read(file) { return fs.readFileSync(file, 'utf8'); }

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
    // 定义本身占一次，所以「至少 5 次」= 定义 + 播放 + 预取 + 解码收口 + 内部反推。
    const uses = count(state, 'online_quality_for(');
    ok(uses >= 5, `state.rs 里 online_quality_for 的调用/定义共 ${uses} 处，少于 5 处（有一处取档没夹上限）`);
    // 裸读偏好的写法只许留在 online_quality_for 内部与设置页的档位描述里。
    const rawReads = count(state, 'crate::online::quality::get(&prefs');
    ok(rawReads <= 1, `state.rs 生产代码里裸读 quality::get(&prefs 出现 ${rawReads} 次，应当只剩 helper 内那 1 次`);
    ok(count(beats, 'online_quality_for(') === 1,
      'stage_beats.rs 的在线曲缓存查找要走夹上限的档位（否则被降档那首永远找不到文件）');
    ok(!/crate::online::quality::get\(&prefs/.test(beats),
      'stage_beats.rs 不许再按原始偏好拼档位');
  }

  section('失败收口点：两处都得记上限');
  {
    const state = shipped(read(STATE));
    ok(/fn online_failed[\s\S]{0,4000}note_quality_failure\(&track_id, e\.code\)/.test(state),
      'online_failed 里要记上限（取流/下载/提交失败都收口在这）');
    ok(/handle_decode_failure[\s\S]{0,6000}note_quality_failure\(&track_id, "decode_stalled"\)/.test(state),
      'handle_decode_failure 里要记上限（解码线程半路夭夭是最强的档位证据）');
    // 上限判定不能顺手把接力那套码表复制过来：auth_required / not_found 在接力
    // 里成立，在降档里恰恰是必须排除的两类（账号级证据归登录流程，曲下架换档无用）。
    const elig = /fn ceiling_eligible[\s\S]{0,600}?\n    \}/.exec(state);
    ok(elig, 'ceiling_eligible 还在（哪些失败算「这一档给不出来」的判据）');
    if (elig) {
      ok(!/auth_required/.test(elig[0]), 'ceiling_eligible 不许把 auth_required 算进来（账号级失败不该压低整首歌）');
      ok(!/not_found/.test(elig[0]), 'ceiling_eligible 不许把 not_found 算进来（下架换档也放不了）');
      ok(!/upstream_timeout/.test(elig[0]), 'ceiling_eligible 不许把 upstream_timeout 算进来（抖动不是档位的错）');
      for (const code of ['vip_required', 'upstream_rejected', 'decode_stalled']) {
        ok(elig[0].includes('"' + code + '"'), `ceiling_eligible 该收 ${code}`);
      }
      ok(!/relay_eligible/.test(elig[0]), 'ceiling_eligible 不许直接复用接力的码表（两类的判据不同）');
    }
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
