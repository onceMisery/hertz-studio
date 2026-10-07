#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 出处身份 vs 供音身份的接线契约检查（零依赖、不触网）。
//
//   node scripts/check-source-origin.js
//
// 对应借鉴清单 §8 F3。曲源接力（F1）会把队列里这一项换成另一家平台的虚拟 id：
// 缓存键、音质、取流、播放历史、打卡从此都跟着**实际供音那一家**走，于是「用户
// 当初点的是哪家」在系统里再无处可查 —— 详情说不清、收藏落错家、用户也不知道
// 为什么网易云那一首现在由酷狗在放。本批只**保留出处**并把它说清楚；业务策略
// （收藏落到哪家、换源后要不要按原平台打卡）另议，不在这里顺手改。
//
// 规则本体（`ensure_origin` 只记第一家、`relayed` 的比较、旧 payload 缺字段照收）
// 有 Rust 单元测试与 check-online.js 的真模块执行覆盖。这里钉的是它们之外那些
// 「不报错、只是看不见」的接线：
//
//   1. 事件必须把 `from_track_id` 与三个 origin 字段都带出去。少了 from_track_id，
//      前端找不到自己要迁的那条元数据 —— 队列那行会退化成平台 id。
//   2. origin 字段不许 `skip_serializing_if`：可缺席就等于把「没换过源」和
//      「服务端没告诉你」合成同一种样子。
//   3. 前端迁移只在「换的就是当前这首」时重绘，否则切歌后会把界面改错。
//   4. 出处那一行的显示条件是「出处 ≠ 供音」，不是「有 origin 字段」—— 服务端
//      在没换过源时也会给出处（就是它自己），按后者判断会永远挂着一条废话。
//   5. 旧 payload 的兼容性（缺 `origin` 字段）由 Rust 测试钉住 —— `Option` 缺
//      字段 serde 天然取 None，写 `#[serde(default)]` 是冗余，别拿它当兼容性证明。

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/// 这个仓库的换行符是混的（app.js 是 CRLF、Rust 侧是 LF）。多行正则要先归一，
/// 否则 `\n` 在 CRLF 文件里永远配不上，检查会假绿或假红。
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

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

function bodyOf(src, head) {
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

/// 枚举变体的文本：从 `Name {` 起到配平的 `}`。
function variant(src, head) {
  return bodyOf(src, head);
}

(function main() {
  section('服务端：字段与迁移');
  {
    const state = read('crates/hertz-studio/src/state.rs');
    const snap = variant(state, 'pub struct OnlineMetaSnap {');
    ok(snap, 'OnlineMetaSnap 抓得到');
    if (snap) {
      ok(/出处/.test(snap), '这个字段存在的理由写在字段上，别让下一个人当冗余删掉');
      ok(/pub origin: Option<OnlineOrigin>/.test(snap),
        'origin 是 Option：serde 对缺字段天然取 None，旧 payload 才照收');
    }
    const originStruct = variant(state, 'pub struct OnlineOrigin {');
    ok(originStruct && /pub source: String/.test(originStruct) && /pub id: String/.test(originStruct),
      'OnlineOrigin 带 source 与 id');
    ok(/fn snap_without_origin_field_still_deserializes/.test(state),
      '旧 payload 缺 origin 的兼容性有真测试钉着（不是靠 serde 属性）');

    const ensure = bodyOf(state, 'pub(crate) fn ensure_origin(');
    ok(ensure, 'ensure_origin 抓得到');
    if (ensure) {
      ok(/if self\.origin\.is_some\(\) \{\s*return;/.test(ensure),
        '已有出处就直接返回 —— 多跳接力必须记第一家，不是上一家');
    }

    const relay = bodyOf(state, 'async fn try_relay(');
    ok(relay, 'try_relay 抓得到');
    if (relay) {
      ok(/snap\.ensure_origin\(/.test(relay), '迁移元数据时补出处（在插入新 id 之前）');
      ok(relay.indexOf('ensure_origin') < relay.indexOf('map.insert(new_id'),
        '先定出处再落表：反了新 id 名下的快照就没有出处');
      ok(/split_virtual_id\(&track_id\)/.test(relay) && /failed_id/.test(relay),
        '失败那一项的 source 与平台 id 都要拿到（出处需要两个都得是真的）');
    }
  }

  section('事件形状：三个 origin 字段与 from_track_id 都要在');
  {
    const state = read('crates/hertz-studio/src/state.rs');
    const ev = variant(state, 'SourceSwitched {');
    ok(ev, 'WsEvent::SourceSwitched 抓得到');
    if (ev) {
      for (const f of ['track_id', 'from_track_id', 'origin_source', 'origin_id', 'origin_label']) {
        ok(new RegExp('\\b' + f + ': String,').test(ev), `事件带 ${f}（缺一个前端就得自己猜）`);
      }
      ok(!/skip_serializing_if/.test(ev),
        '这些字段不许可缺席：省略就把「没换过源」和「服务端没说」捏成同一个样子');
    }
    const publish = /self\.publish\(WsEvent::SourceSwitched \{([\s\S]{0,1600}?)\n            \}\);/.exec(state);
    ok(publish, '发布点抓得到');
    if (publish) {
      ok(/from_track_id: track_id\.clone\(\)/.test(publish[1]),
        'from_track_id 发的是被换掉那一项：前端拿它找自己那份元数据');
      ok(/origin_source:/.test(publish[1]) && /origin_id:/.test(publish[1]),
        '出处两个字段都从迁移块算出的 origin 来');
    }
  }

  section('前端：迁移、重绘条件与那一行措辞');
  {
    const app = read('plugin/ui/app.js');
    const handler = /case 'source_switched': \{([\s\S]{0,1400}?)\n      break;\n    \}/.exec(app);
    ok(handler, 'app.js 的 source_switched 分支抓得到');
    if (handler) {
      ok(/Online\.relayMeta\(msg\)/.test(handler[1]), '换源后要把前端那份元数据迁到新 id');
      ok(/state\.current\.id === msg\.from_track_id/.test(handler[1]),
        '只有换的是当前这首才重绘，否则切歌后会把界面改错');
      ok(/pushStageQueue\(\)/.test(handler[1]),
        '迁移后要重推队列：3D 歌单架只认这里喂的数据，不重推会停在占位卡');
    }
    const sync = bodyOf(app, 'function syncNpTrack(track, coverUrl)');
    ok(sync, 'syncNpTrack 抓得到');
    if (sync) {
      ok(/track\.origin\.source !== track\.source/.test(sync),
        '出处那行的条件是「出处不等于供音」，不是「有没有 origin 字段」');
      ok(/np\.origin\.hidden = !show/.test(sync), '没换源时整行收起');
      ok(/原音源/.test(sync) && /供音/.test(sync), '措辞要同时说清点的是谁、现在谁在放');
    }
    ok(/origin: \$\('np-origin'\)/.test(app), 'np 弹窗绑到 np-origin 节点');

    const html = read('plugin/ui/index.html');
    ok(/id="np-origin" hidden/.test(html), '浮层默认收起：没换过源不该在详情里挂一行废话');
    ok(/class="np-origin"/.test(html), '出处行有样式钩子');
    const css = read('plugin/ui/style.css');
    ok(/\.np-origin \{/.test(css), 'style.css 里有 .np-origin 规则（无规则等于没排版）');
  }

  section('两个播放门面都回出处');
  {
    const routes = read('crates/hertz-studio/src/routes.rs');
    const rpc = read('crates/hertz-studio/src/rpc/online.rs');
    for (const [name, src] of [['HTTP', routes], ['RPC', rpc]]) {
      ok(/state\.online_origin\(&vids\[index\]\)\.await/.test(src),
        `${name} 门面从队列快照取出处（同一个入口，不各算一遍）`);
      ok(/"origin": origin/.test(src) && /"relayed": relayed/.test(src),
        `${name} 门面的播放响应带 origin 与 relayed（只改一边就是插件形态看不见出处）`);
    }
    ok(/pub\(crate\) async fn online_origin\(/.test(read('crates/hertz-studio/src/state.rs')),
      'AppState::online_origin 是唯一出口');
    // 没快照与「没换过源」不能混成一种：None 走 is_none 分支，False 走 relayed。
    ok(/None => \(None, false\)/.test(routes) && /None => \(None, false\)/.test(rpc),
      '两个门面都把「没有快照」显式写成 origin=null + relayed=false');
    const online = read('plugin/ui/online.js');
    ok(/res\.relayed && res\.origin/.test(online), '前端播放路径会吃服务端给的出处');
  }

  console.log(`\n出处身份契约检查：${checks} 项` + (failures ? `，${failures} 项失败` : '全部通过'));
  process.exit(failures ? 1 : 0);
}());
