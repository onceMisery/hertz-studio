#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 每曲歌词校准的接线契约检查（零依赖、不触网）。
//
//   node scripts/check-lyric-calibration.js
//
// 对应借鉴清单 §9 的 G11。我们本来就有完整的本地每曲校准（存储、读取端叠加、
// np 弹窗 ±0.5s、舞台内微调、乐观暂存与失败回清），但在线曲目被三处代码明确
// 挡在门外，理由写的是「在线歌词来自平台接口，没有偏移语义」。那句话在存储层
// 就不成立：`track_lyrics` 的主键是播放侧的曲目身份，在线曲是虚拟 id
// `online:<source>:<ref>`，那张表没有外键，偏移行由 `set_offset` 自己 upsert。
// 平台给的时间轴一样会整体偏，用户校正的从来是时间不是文本 —— 为了校一首在线
// 歌只能去动全局偏移，而全局偏移会把它也改到所有别的歌上。
//
// 本批接通之后要钉的是接线，因为存储与算法都有 Rust 测试，而这几条失败形态
// 全都「不报错、只是没效果」：
//
//   1. 三处在线拦截不许回来（np 弹窗、app.js 的舞台控制分发、stage3d 的微调按钮）。
//   2. 迟到保存不许改新歌的读数：await 期间用户可能已经切歌。
//   3. 读取端三段都要查这张表：`/v1/online/lyric`、`/v1/overlay/lyric` 的在线
//      分支、以及 RPC 门面。少接一段就是「主页校准有效、OBS 浮层没变」或
//      「独立形态有效、dbx 插件形态没反应」。
//   4. 偏移只能各应用一次：文件 [offset:] + 每曲用户偏移在服务端一次，全局偏移
//      在前端 stageDoc 一次（浮层那条链是服务端把三者加完再应用）。`apply_offset`
//      不是幂等的，加两次就是每次都多偏一次。
//   5. 写入端不许长出「曲目必须已在库」的前置检查：在线曲没有 tracks 行。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

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
function count(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/// JS 函数体：从 `head` 起按花括号配平取整段。
function jsBody(src, head) {
  const at = src.indexOf(head);
  if (at < 0) return null;
  const i = src.indexOf('{', at);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(at, j + 1);
    }
  }
  return null;
}

/// 从 `head` 起取到函数签名后第一个 `{` 的配平块（Rust 侧同样够用）。
function rustBody(src, head) {
  return jsBody(src, head);
}

(function main() {
  section('三处在线拦截都已撤掉');
  {
    const app = read('plugin/ui/app.js');
    const npShift = jsBody(app, 'const shiftLyricOffset = async (delta) =>');
    ok(npShift, 'np 弹窗的偏移处理抓得到');
    if (npShift) ok(!/startsWith\('online:'\)/.test(npShift),
      'np 弹窗不许再按 online: 前缀拦截校准');
    const control = /case 'lyricOffset': \{[\s\S]{0,900}?\n    \}/.exec(app);
    ok(control, '舞台控制分发的 lyricOffset 分支抓得到');
    if (control) ok(!/startsWith\('online:'\)/.test(control[0]),
      'app.js 的舞台 lyricOffset 不许再拦在线曲');
    const nudge = jsBody(read('plugin/ui/stage3d.js'), 'function nudge(d) {');
    ok(nudge, 'stage3d 的微调按钮抓得到');
    if (nudge) ok(!/indexOf\('online:'\)/.test(nudge),
      'stage3d 的歌词校准不许按前缀早退');
    // 无歌词时控件该收起，但那是「有没有文本」的判断，不是在线/本地的判断。
    ok(/np\.lyricOffset\.hidden = online \? !hasLines : false;/.test(app),
      '在线曲只在「真没有歌词」时收起校准控件');
    ok(!/np\.lyricOffsetMs = online/.test(app) && /np\.lyricOffsetMs = !doc \? 0 : \(doc\.user_offset_ms \|\| 0\);/.test(app),
      '读数对两种来源同一份：doc.user_offset_ms');
  }

  section('迟到保存不许改新歌的读数');
  {
    const npShift = jsBody(read('plugin/ui/app.js'), 'const shiftLyricOffset = async (delta) =>') || '';
    const put = npShift.indexOf('transport.put');
    ok(put >= 0, '偏移写入在这里发生');
    const after = npShift.slice(put);
    ok(/state\.current\.id !== id/.test(after),
      'await 之后必须复核当前曲，否则切歌期间落回来的会写成新歌的读数');
  }

  section('读取端三段都查这张表');
  {
    const routes = read('crates/hertz-studio/src/routes.rs');
    const rpcOnline = read('crates/hertz-studio/src/rpc/online.rs');
    const body = rustBody(routes, 'pub(crate) async fn online_lyric_body(');
    ok(body, 'online_lyric_body 抓得到（HTTP 与 RPC 共用的那一份）');
    if (body) {
      ok(/lyrics_user_offset\(/.test(body), '在线取词要查每曲偏移');
      ok(/virtual_id\(source, ref_id\)/.test(body), '查的键是播放侧的虚拟 id');
      ok(/apply_offset\(&mut doc\)/.test(body), '服务端一次应用');
      ok(count(body, 'apply_offset') === 1, 'apply_offset 在这条链上只出现一次（它不幂等）');
      ok(/"user_offset_ms"/.test(body), '响应要把读数带给界面，不然控件显示 0');
    }
    ok(/crate::routes::online_lyric_body|online_lyric_body\(/.test(rpcOnline),
      'RPC 门面共用同一份在线取词链（只改 HTTP 就是插件形态没反应）');
    const overlay = rustBody(routes, 'pub(crate) async fn overlay_lyric_data(');
    ok(overlay, 'overlay_lyric_data 抓得到');
    if (overlay) {
      ok(count(overlay, 'lyrics_user_offset(') === 1,
        '浮层的在线分支要加每曲偏移（本地分支那份额外叠加保持原样）');
      ok(count(overlay, 'apply_presentation_offset(&mut doc, global_offset)') === 1,
        '浮层按主舞台相同顺序应用来源/每曲与全局偏移，包含零点饱和');
    }
    const setter = rustBody(routes, 'async fn set_lyrics_offset(');
    ok(setter, '偏移写入端点抓得到');
    if (setter) {
      ok(!/get_track/.test(setter),
        '写入端不许要求曲目已在库里：在线曲没有 tracks 行，加了这个检查就等于又把在线曲关在门外');
    }
  }

  section('偏移的唯一 owner 与前端的一份时间语义');
  {
    const routes = read('crates/hertz-studio/src/routes.rs');
    ok(count(routes, 'async fn lyrics_user_offset(') === 1,
      '「读这首的用户偏移」只有一个 owner，本地与在线都走它');
    const stage = read('plugin/ui/stage.js');
    ok(/doc\.user_offset_ms/.test(stage),
      '舞台侧的偏移读数来自 doc.user_offset_ms（与浮层同一份语义，不是第二次加）');
    const app = read('plugin/ui/app.js');
    const state = { settings: { lyrics_staff_policy: 'keep', global_lyric_offset_ms: 500 } };
    const context = vm.createContext({state, Set, Map});
    vm.runInContext(app.slice(app.indexOf('const LYRIC_STAFF_DEFAULT ='), app.indexOf('// online.js 的在线直取路径')), context);
    const doc = {user_offset_ms: 200, lines: [{start_ms:1000,end_ms:2000,text:'hello',words:[{start_ms:1000,end_ms:1500,text:'hello'}]}]};
    const original = JSON.stringify(doc);
    context.doc = doc;
    const shifted = vm.runInContext('stageDoc(doc)', context);
    assert.equal(shifted.lines[0].start_ms,1500);
    assert.equal(shifted.lines[0].words[0].end_ms,2000);
    assert.equal(shifted.user_offset_ms,200,'Global offset must not become a per-track nudge');
    assert.equal(JSON.stringify(doc),original,'Presentation cannot mutate the cached raw response');
    assert.equal(vm.runInContext('stageDoc(doc).lines[0].start_ms',context),1500,'Repeated presentation cannot accumulate offsets');
    state.settings.global_lyric_offset_ms=-2000;
    assert.equal(vm.runInContext('stageDoc(doc).lines[0].start_ms',context),0);
    state.settings.global_lyric_offset_ms=0;
    state.settings.lyrics_staff_policy='hide';
    context.doc={lines:[{start_ms:0,text:'作词：甲'},{start_ms:1000,text:'keep'},{start_ms:2000,text:'skip'}],translation:['staff','translated','skip'],romanization:['staff','roman','skip']};
    state.settings.lyrics_filter_enabled=true;state.settings.lyrics_filter_pattern='^skip$';
    const filtered=vm.runInContext('stageDoc(doc)',context);
    assert.deepEqual(Array.from(filtered.translation),['translated']);
    assert.deepEqual(Array.from(filtered.romanization),['roman']);
    ok(true,'真实 stageDoc：行/词偏移、饱和、重复呈现、校准读数与译文/罗马音过滤保持一致');
  }

  console.log(`\n歌词校准契约检查：${checks} 项` + (failures ? `，${failures} 项失败` : '全部通过'));
  process.exit(failures ? 1 : 0);
}());
