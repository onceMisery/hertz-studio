#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 舞台控制舱的契约检查（零依赖静态分析）。
//
// 「滑块能拖动但画面毫无反应」是这一层最隐蔽的故障：每个配置都要经
//   SCHEMA 默认值 → push() 写变量/类/数据集 → CSS 或其他 JS 消费
// 这条链。任何一个目标名写错（如曾经的 --fx 挂到不存在的 .disc-img），
// 浏览器不报错、滑块照常动。本脚本做两件事：
//   1. 从 stage-control.js 解析 SCHEMA，逐项推导它写入的目标；
//   2. 在其余所有 web 文件里断言该目标存在真实消费方。
//
//   node scripts/check-stage-control.js

'use strict';

const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'crates', 'vmusicd', 'web');

let failures = 0;
let checks = 0;

function ok(cond, label) {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error('  ✗ ' + label);
  }
}

function readWeb(file) {
  return fs.readFileSync(path.join(WEB, file), 'utf8');
}

const controlSrc = readWeb('stage-control.js');

// 消费方宇宙：除面板自身外的全部 web 源
const allFiles = fs.readdirSync(WEB).filter((f) => f.endsWith('.js') || f.endsWith('.css') || f.endsWith('.html'));
const consumerSrc = allFiles
  .filter((f) => f !== 'stage-control.js')
  .map(readWeb)
  .join('\n');

// ---------------------------------------------------------------------------
// 1. 截取 SCHEMA 区域并解析分组
// ---------------------------------------------------------------------------
const schemaStart = controlSrc.indexOf('var SCHEMA = [');
// SCHEMA 的闭合是行首两空格缩进的 `];`（fmt 函数体内的 `];` 缩进更深，
// 不能用 indexOf('];')，否则区域被提前截断）。
const afterStart = controlSrc.slice(schemaStart);
const closeM = afterStart.match(/\n  \];/);
const schemaText = afterStart.slice(0, closeM.index);

// 解析：按组（id）→ 段落（items / selects）→ 控件块（按花括号配平，
// 允许多行 fmt/css）。
const groups = [];
{
  const allLines = schemaText.split('\n');
  let group = null;
  let section = 'items';

  for (let li = 0; li < allLines.length; li += 1) {
    const line = allLines[li];
    const idM = line.match(/^\s+id:\s*'([^']+)'/);
    if (idM) {
      group = { id: idM[1], items: [], selects: [] };
      groups.push(group);
      section = 'items';
      continue;
    }
    if (/^\s*items:\s*\[/.test(line)) { section = 'items'; continue; }
    if (/^\s*selects:\s*\[/.test(line)) { section = 'selects'; continue; }

    const keyM = line.match(/key:\s*'([^']+)'/);
    if (keyM && group) {
      // 从本行起按花括号深度收集完整控件块
      let depth = 0;
      let block = '';
      let j = li;
      let started = false;
      for (; j < allLines.length; j += 1) {
        const cur = allLines[j];
        for (const ch of cur) {
          if (ch === '{') { depth += 1; started = true; }
          else if (ch === '}') depth -= 1;
        }
        block += cur + '\n';
        if (started && depth <= 0) break;
      }
      li = j;
      group[section].push({
        key: keyM[1],
        type: (block.match(/type:\s*'([^']+)'/) || [])[1] || null,
        css: /\bcss:/.test(block),
        raw: block,
      });
    }
  }
}

console.log(`SCHEMA 解析：${groups.length} 组，` +
  `${groups.reduce((n, g) => n + g.items.length, 0)} 个控件，` +
  `${groups.reduce((n, g) => n + g.selects.length, 0)} 个下拉`);

ok(groups.length >= 5, 'SCHEMA 至少 5 组（解析未错位）');

// ---------------------------------------------------------------------------
// 2. 解析带 css: 的显式目标名（同行字符串或数组在下一行，简单覆盖同行场景）
// ---------------------------------------------------------------------------
function cssTargets(entry) {
  const single = entry.raw.match(/css:\s*'(--[^']+)'/);
  if (single) return [single[1]];
  const arrM = entry.raw.match(/css:\s*\[([^\]]+)\]/);
  if (arrM) return [...arrM[1].matchAll(/'(--[^']+)'/g)].map((m) => m[1]);
  return null;
}

// 事件型消费：键名出现在 stagecontrol:change 监听方源码里
function consumedByEvent(key) {
  return new RegExp('\\.' + key + '\\b').test(consumerSrc) ||
    new RegExp('detail\\.' + key).test(consumerSrc) ||
    new RegExp('\\bopts\\.' + key + '\\b').test(consumerSrc);
}
function consumedVar(name) {
  const esc = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  // CSS var() 消费
  if (new RegExp('var\\(\\s*' + esc + '\\b').test(consumerSrc)) return true;
  // JS 读取消费：getPropertyValue('--name') / num('--name',…)
  if (new RegExp("['\"]" + esc + "['\"]").test(consumerSrc)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 3. 逐项契约
// ---------------------------------------------------------------------------
const seen = new Set();

for (const g of groups) {
  for (const it of g.items) {
    ok(!seen.has(it.key), `控件键唯一：${it.key}（无重复/共用值）`);
    seen.add(it.key);

    let target = null;
    let kind = 'var';

    if (it.type === 'color') {
      target = ['--lyric-color'];
    } else if (it.css) {
      target = cssTargets(it);
      ok(!!target, `${it.key}: css 显式目标可解析`);
    } else if (it.key === 'enabled') {
      // 总开关：消费为 html.fx-on 规则
      ok(/html\.fx-on/.test(consumerSrc), `${it.key}: fx-on 滤镜层存在`);
      continue;
    } else if (g.id === 'global' && it.key === 'intensity') {
      // 源头不再写 --fx-global-intensity；真实目标是单独的 --fx-intensity
      target = ['--fx-intensity'];
    } else {
      target = ['--fx-' + g.id + '-' + it.key];
    }

    if (!target) continue;

    for (const t of target) {
      // 先查 var/JS读取；motion 组与 lyrics.beatAmp 允许事件消费（读 detail）
      const viaVar = consumedVar(t);
      const viaEvent = (g.id === 'motion' || g.id === 'cine' ||
        (g.id === 'lyrics' && it.key === 'beatAmp')) && consumedByEvent(it.key);
      ok(viaVar || viaEvent,
        `${it.key} → ${t} 有真实消费方（${viaVar ? 'CSS' : 'event'}）`);
    }
  }

  for (const st of g.selects) {
    ok(!seen.has(st.key), `下拉键唯一：${st.key}`);
    seen.add(st.key);

    if (st.css) {
      const target = cssTargets(st);
      ok(!!target && target.every((t) => consumedVar(t)),
        `${st.key}: css 目标有消费`);
    } else if (st.key === 'stagePreset') {
      ok(/data-stage-preset=/.test(consumerSrc),
        'stagePreset: 数据集被 CSS 选择器消费');
    } else {
      const t = '--fx-' + g.id + '-' + st.key;
      ok(consumedVar(t), `${st.key} → ${t} 有消费方`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. 架构回归断言（已修复问题不再复发）
// ---------------------------------------------------------------------------
ok(/def:\s*true\s*\},?\s*\n\s*\{ key: 'intensity'/.test(controlSrc),
  '舞台滤镜总开关默认启用（修复「拖旋钮无反应」）');
ok(!/paletteMode/.test(controlSrc),
  '已移除无消费方的 paletteMode 死控件');
ok(!/\.disc-img\s*[,{]/.test(readWeb('stage.css')),
  '已移除永不生效的 .disc-img 规则');

// 总强度变量必须被多处消费
ok(consumedVar('--fx-intensity'), '--fx-intensity 总强度有消费方');

console.log(`\n舞台控制契约：${checks} 项检查，` +
  (failures ? `${failures} 个失败` : '全部通过'));
process.exit(failures ? 1 : 0);
