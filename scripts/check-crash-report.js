#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 崩溃可观测性的接线契约检查（零依赖、不触网）。
//
//   node scripts/check-crash-report.js
//
// 对应借鉴清单 §4 的 D3。落盘的算法（时间戳、取值、裁剪、隐去 query）都有 Rust
// 单元测试，这里钉的是**形状与接线** —— 这一类错误的共同特征是「不报错，只是
// 崩了之后什么都没留下」：
//
//   1. 钩子必须在 `diag::init` 之后立刻装好，并且早于任何可能 panic 的装配步骤。
//      晚一步就意味着启动期那几次崩溃恰好是没有任何记录的那几次。
//   2. 记崩溃那一行必须**绕过诊断开关**。开关是用户为了录播放过程才按的，进程
//      自己没了的时候它通常是关着的 —— 那时「它闪退了」这句话没有任何可交接的
//      东西，下一次崩溃还是对不上。
//   3. 钩子自己绝不能再 panic，也不能吞掉默认钩子（终端里的原始 panic 输出是给
//      开发者自己的）。
//   4. 裁剪要两阶段写。`File::create` 会先把日志截成 0 再重写，而裁剪恰恰发生在
//      日志最长、最可能有内容的那一刻；卡在中间就同时丢了旧记录和崩溃现场。
//   5. 编号要能走到用户眼前：`/v1/diagnostics` 带 last_crash，设置页那一行
//      的存在性**不取决于**诊断开关。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

/// 只保留代码行：负面断言（「不许出现 X」）必须先抹掉注释，否则会被解释这条禁令
/// 的那句注释自己打红 —— 注释里写 `原先直接 File::create(path)` 是来由，不是复活。
function codeOnly(text) {
  return text.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
}

/// 从源码里按名字抠出一个完整函数（花括号配平），原样执行。
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
  section('钩子的位置与形状');
  {
    const boot = read('crates/hertz-studio/src/bootstrap.rs');
    const init = boot.indexOf('diag::init(');
    const hook = boot.indexOf('diag::install_panic_hook()');
    ok(init >= 0, 'bootstrap 里初始化了 diag');
    ok(hook >= 0, 'bootstrap 装了 panic 钩子');
    ok(init >= 0 && hook > init, '钩子必须在 diag::init 之后（否则写不出路径）');
    const later = boot.indexOf('let state = Arc::new(AppState');
    ok(hook >= 0 && (later < 0 || hook < later),
      '钩子要早于播放状态装配：装配期那几次崩溃最容易一个记录都不留');
    const installer = bodyOf(read('crates/hertz-studio/src/diag.rs'), 'pub fn install_panic_hook()');
    ok(installer, 'install_panic_hook 抓得到');
    if (installer) {
      ok(/take_hook\(\)/.test(installer) && /previous\(info\)/.test(installer),
        '写完要交回默认钩子，不能把终端里的原始 panic 输出吞掉');
      ok(/crash\(/.test(installer), '钩子落到同一个 crash()（现场只有一种写法）');
    }
  }

  section('记崩溃绕过开关，且不制造新的 panic');
  {
    const diag = read('crates/hertz-studio/src/diag.rs');
    const crash = bodyOf(diag, 'pub fn crash(');
    ok(crash, 'crash() 抓得到');
    if (crash) {
      ok(/write_line\(/.test(crash), '崩溃行走 write_line（直接落盘）');
      ok(!/event\(/.test(crash),
        '不许走 event()：那条路先查 ENABLED，而进程崩时开关通常是关的');
      ok(/LAST_CRASH/.test(crash), '同一份现场还要留在进程内给诊断面板');
      ok(/unwrap_or_else\(\|e\| e\.into_inner\(\)\)/.test(crash),
        '取锁要容忍 poisoned：在 panic 展开过程中拿锁正是本行的来由');
    }
    ok(/"panic report=/.test(read('crates/hertz-studio/src/diag.rs'))
      || /write_line\(\s*"panic"/.test(diag),
      '落盘的 kind 是 panic，字段里有 report');
  }

  section('裁剪是两阶段写');
  {
    const diag = read('crates/hertz-studio/src/diag.rs');
    const trim = bodyOf(diag, 'fn trim_if_over(');
    ok(trim, 'trim_if_over 抓得到');
    if (trim) {
      ok(/rename/.test(trim), '先写临时文件再 rename 覆盖');
      ok(!/File::create\(path\)/.test(codeOnly(trim)),
        '不许再直接 File::create(path)：那会先把日志截成 0 再重写');
      ok(/\.tmp/.test(trim), '临时名走同一个目录（跨目录 rename 不是原子的）');
    }
  }

  section('编号要走到用户眼前');
  {
    const routes = read('crates/hertz-studio/src/routes.rs');
    const diagJson = bodyOf(routes, 'pub(crate) fn diagnostics_json()');
    ok(diagJson && /"last_crash"/.test(diagJson), '/v1/diagnostics 带 last_crash');
    ok(diagJson && /crate::diag::last_crash\(\)/.test(diagJson),
      '它直接取 diag 的进程内记录，不在路由里另算一份');
    const app = read('plugin/ui/app.js');
    ok(/ui\.devDiagCrash\.hidden = !crash;/.test(app),
      '崩溃那一行的存在性只看有没有崩溃，不跟诊断开关联动');
    ok(!/ui\.devDiagCrash\.hidden = !on;/.test(app),
      '不许把崩溃提醒藏在诊断开关后面（崩的时候它通常是关的）');
    ok(/crash\.report/.test(app) && /crash\.where/.test(app) && /crash\.message/.test(app),
      '编号、位置、原因三个都要显示：口头报得上来的只有编号');
    const html = read('plugin/ui/index.html');
    ok(/id="dev-diag-crash" hidden/.test(html),
      '默认收起：没有崩溃时不该在设置页摆一条吓人的空行');
    ok(/id="dev-diag-crash-text"/.test(html), '文本节点存在（JS 按 id 取它）');
  }

  section('渲染恢复预算（执行真实模块里的纯函数）');
  {
    const src = read('plugin/ui/stage3d.js');
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(grabFn(src, 'function pruneRecoveries(') + '\n'
      + grabFn(src, 'function takeRecovery(')
      + '\nthis.prune = pruneRecoveries; this.take = takeRecovery;', ctx);
    const W = 120000, MAX = 3;
    let hist = [];
    for (let i = 0; i < MAX; i += 1) {
      const got = ctx.take(hist, 1000 + i * 1000, W, MAX);
      ok(got !== null, `窗口内第 ${i + 1} 次丢失应当还允许恢复`);
      hist = got || hist;
    }
    ok(ctx.take(hist, 4000, W, MAX) === null,
      `窗口内第 ${MAX + 1} 次必须停用，不能再重建一遍着色器链`);
    // 窗口滑走之后要能再试：一次驱动重置不该变成整场不可用。
    ok(ctx.take(hist, 1000 + MAX * 1000 + W, W, MAX) !== null,
      '窗口过去之后预算重新可用');
    const kept = ctx.prune([0, 50000, 90000], 100000, W);
    ok(kept.length === 3 && kept[0] === 0, '都在窗口内时保持顺序与内容');
    ok(ctx.prune([0, 10], 200000, W).length === 0, '整窗之外一律剪光');
    ok(ctx.prune([0], W, W).length === 0, '恰好等于窗口的记录算出窗（边界不许含糊）');
    ok(ctx.take([], 0, W, 0) === null, '预算为 0 时一次都不许试');

    const lost = bodyOf(src, 'function onContextLost(e)');
    ok(lost, 'onContextLost 抓得到');
    if (lost) {
      ok(lost.indexOf('takeRecovery(') < lost.indexOf('contextLost = true'),
        '先判预算再进入恢复态：反过来就是每次都重建');
      ok(/glStopped = true/.test(lost) && /contextLost = false/.test(lost),
        '停用时两个状态位都要落对：contextLost 留着就是谎报「正在恢复」');
      ok(/releaseGl\(\)/.test(lost), '停用要真的摘掉画布与两个监听');
    }
    ok(/glFailed \|\| glStopped/.test(src), 'ensureGl 认这个停用位');
    ok(/if \(glStopped && recoveryAt\.length\)/.test(src),
      'ensureGl 里要有过期重评：窗口过后用户再进三维该再给一次机会');
    const stopped = /var RECOVERY_STOPPED_TEXT = ([\s\S]{0,420}?);/.exec(src);
    ok(stopped, '停用的文案抓得到');
    if (stopped) {
      ok(/开发者选项/.test(stopped[0]), '那句话要告诉用户去哪儿取证');
      ok(/丢失/.test(stopped[0]) && /次/.test(stopped[0]), '要说清丢了几次，才解释得掉为什么停用');
      ok(!/正在恢复/.test(stopped[0]), '停用的措辞不许再说「正在恢复」');
    }
    const shown = /if \(glFailed\) showFallback[\s\S]{0,300}?else if \(contextLost\)/.exec(src);
    ok(shown && /glStopped/.test(shown[0]),
      '回到舞台轨时按 glFailed / glStopped / contextLost 三种状态分别措辞');
  }

  console.log(`\n崩溃报告契约检查：${checks} 项` + (failures ? `，${failures} 项失败` : '全部通过'));
  process.exit(failures ? 1 : 0);
}());
