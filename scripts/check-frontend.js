#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 前端检查的聚合入口：一条命令跑完 CI 里那一整串契约检查，顺序照 CI 一致。
//
//   node scripts/check-frontend.js            # CI 的那一组（无浏览器、不触网）
//   node scripts/check-frontend.js --extra    # 再加上只在本地跑的一批无浏览器检查
//   node scripts/check-frontend.js --live     # 追加需要真浏览器 + 起着的服务的活体检查
//   node scripts/check-frontend.js --only check-online
//
// 为什么要聚合：CI 以前把 20 条 `node scripts/check-*.js` 平铺在 workflow 里，
// 于是本地想全跑一遍只能把那段 YAML 复制进终端，而终端里跑不了 YAML 注释掉的
// 判断依据。更要紧的是顺序：语法检查必须排在契约检查前面——一个文件写坏了
// 会让十几个沙箱各自报出各不相同的怪错，第一条红才是唯一有用的那条。
//
// 阶段划分：语法 → 静态 guard（形状/接线/禁用词）→ 行为回归（vm 沙箱跑真实模块）
// → 活体（默认不跑）。默认集合与 .github/workflows/ci.yml 里那一步严格等价，
// 所以这个脚本可以当 CI 的本地替身用；`--extra` 里的脚本 CI 暂时不跑（把它们
// 提进 CI 之前要先确认它们在 CI 环境里也稳）。
//
// 退出码：有任何一步失败就是 1，全绿是 0。

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// —— 第 1 阶段：语法 ——
// 直接对真实文件跑 `node --check`：契约检查的沙箱只会告诉你「模块加载失败」，
// 不会告诉你是哪一行漏了括号。
const SYNTAX_GLOBS = [
  ['plugin', 'ui'],
  ['plugin', 'ui', 'skins'],
  ['plugin', 'ui', 'stage-themes'],
  ['scripts'],
];
const SYNTAX_SKIP = new Set(['vendor']);

// —— 第 2、3 阶段 ——
// why 字段就是原来贴在 ci.yml 里的判断依据：它解释的是「这条失败意味着什么」，
// 挪到脚本里才不会和 workflow 的 YAML 缩进互相拖累。
const STEPS = [
  { script: 'check-home-dashboard.js', stage: 'behavior',
    why: '继续播放卡必须只读快照、明确主动作，并拦住迟到历史与封面回填。' },
  { script: 'check-creative-share-code.js', stage: 'behavior',
    why: '创意分享码只传递规范化预置，校验版本、长度与损坏内容，导入失败不覆盖当前配置。' },
  { script: 'check-perf-probe.js', stage: 'behavior',
    why: '全局性能探针必须真实采样帧门、保护性能字段白名单，并在两种形态中完整接线。' },
  { script: 'check-cover-lifecycle.js', stage: 'behavior',
    why: '封面代理与解码乱序不能覆盖新选择，代理失败清理旧内容，不持有永久回填订阅。' },
  { script: 'check-beat-lifecycle.js', stage: 'behavior',
    why: '节拍状态绑定当前曲目，未排队分析必须有界补取，迟到响应不能回填。' },
  { script: 'check-daily-view.js', stage: 'behavior',
    why: '每日推荐页的部分成功、来源状态与操作必须纳入 CI。' },
  { script: 'check-assets.js', stage: 'guard',
    why: '前端资源接线：文件在不在、id 对不对、脚本加载顺序。这类失败不会报错，只会「某块界面空着」。' },
  { script: 'check-lineage-names.js', stage: 'guard',
    why: '改名之后的负面不变量：上游项目名不许回到标识符与界面文案（注释里的历史出处按第二档放行）。' },
  { script: 'api-routes.js', stage: 'guard', args: ['--check'],
    why: 'docs/api-routes.md 的 REST 清单是生成物。放开手写必然漂移，改了 routes.rs / main.rs 就重跑生成器。' },
  { script: 'check-css-tokens.js', stage: 'guard',
    why: '颜色/间距只走令牌：硬编码色值在换肤与浅色主题下会变成看不见的字。' },
  { script: 'check-plugin-assets.js', stage: 'guard',
    why: '插件形态（srcdoc + CSP + base href）下壁纸/图标 404 是「不报错、只是空」，独立形态看不出来。' },
  { script: 'check-online.js', stage: 'behavior',
    why: '在线音源：扫码状态机与登录意图归属、聚合搜索、能力闸门、账号态三态、封面与徽标通道。' },
  { script: 'check-quality-ceiling.js', stage: 'behavior',
    why: '每轨音质上限的接线：取档四个入口都夹上限、两处失败收口都记档、服务端事件名与前端分发对得上、降档提示按「这一首+这一档」去重（少接一处只表现为音质时好时坏，不报错）。' },
  { script: 'check-beat-budget.js', stage: 'behavior',
    why: '节拍分析的调度接线：先拿并发额度再写幂等表、额度持到落盘之后、落盘失败记 NotPersisted 而不是失败、HTTP 与 RPC 两个门面消费同一个 persisted（错的一边只表现为「插件里镜头不动」）。' },
  { script: 'check-lyric-calibration.js', stage: 'guard',
    why: '每曲歌词校准对在线曲的接线：三处 online: 前缀拦截已撤、读取端三段（在线取词/浮层在线分支/RPC 门面）都查同一张表、偏移各应用一次、迟到保存不改新歌读数。' },
  { script: 'check-crash-report.js', stage: 'guard',
    why: '崩溃可观测性：钩子在 diag::init 之后立刻装且早于装配、panic 行绕过诊断开关、裁剪两阶段写、编号走到设置页且不藏在开关后面。错的形态是「崩了什么都没留下」。' },
  { script: 'check-search-history.js', stage: 'behavior',
    why: '搜索关键词历史的唯一 owner：真实模块在沙箱里跑规则（大小写去重、置顶、上限 10、一次性搬迁并删旧键、坏了不抛），并钉住「记提交不记逐字输入」、键名只出现一处、命令历史不并进来。' },
  { script: 'check-source-origin.js', stage: 'guard',
    why: '曲源接力的出处身份（F3）：ensure_origin 只记第一家、事件必须带 from_track_id 与三个 origin 字段且不许可缺席、前端只迁当前这首并同步重绘 3D 队列、出处行的显示条件是「出处≠供音」。' },
  { script: 'check-adrs.js', stage: 'guard',
    why: '决策日志与源码一致（D6）：每篇 ADR 三段齐全、索引不缺篇，且「边界与 owner」表里每行的数值必须等于源码常量的字面量。数字被改而文档没跟上（或反过来）就报红。' },
  { script: 'check-online-playlist-view.js', stage: 'behavior',
    why: '集合详情的三态/分页/筛选：按钮只承诺已加载那一段，未取全不许写「播放全部」。' },
  { script: 'check-stage-control.js', stage: 'behavior',
    why: '舞台控制舱：每个旋钮都得有真实消费方，参数搜索与调参撤销在 vm 沙箱里真跑。' },
  { script: 'check-stage-settings.js', stage: 'behavior',
    why: '歌词模式、背景与设备能力共同决定设置是否生效，切换不能丢失原偏好。' },
  { script: 'check-stage-backgrounds.js', stage: 'behavior',
    why: '独立背景覆盖 3D 时隐藏场景选择并停止绘制，切回恢复。' },
  { script: 'check-stage-idle.js', stage: 'behavior',
    why: '空闲收起：报 0 是唯一的停机依据，语义反了就会满帧空转。' },
  { script: 'check-frame-gates.js', stage: 'behavior',
    why: '帧门只兑现整数分频，且不超过声明预算；档位表里不许写除不尽的帧率（旧实现就是这样在 60Hz 上把 48 跑成 30 还自称 48）。' },
  { script: 'check-obs-css.js', stage: 'behavior',
    why: 'OBS 浮层素材通道：生产者与消费者只靠变量名和 url("data:…") 的形状耦合，改错一端不报错。' },
  { script: 'check-skins.js', stage: 'behavior',
    why: '换肤：皮肤自己是一层产品，回退、注入与持久化都只表现为「刷新后回到默认」，很难靠眼看发现。' },
  { script: 'check-appearance-restore.js', stage: 'behavior',
    why: '外观恢复：同上，失败形态是静默丢状态而不是报错。' },
  { script: 'check-favorites.js', stage: 'behavior',
    why: '收藏与每日推荐：混合队列、打卡闸门、播放来源分开记账。' },
  { script: 'check-library.js', stage: 'behavior',
    why: '曲库分页、重试、旧查询与整队列。' },
  { script: 'check-scan-ui.js', stage: 'behavior',
    why: '扫描目录的控件与终态：进度、取消、失败收口。' },
  { script: 'check-creative.js', stage: 'behavior',
    why: '创意编排的参数解析、歌曲时间 cue、真实舞台挂载与唯一帧门。' },
  { script: 'check-scene-registry.js', stage: 'behavior',
    why: '新增场景经真实注册入口进入参数、预置、分享和提示词；歌词渲染器生命周期由宿主统一驱动。' },
  { script: 'check-anime-scenes.js', stage: 'behavior',
    why: '四套绘景的登记/参数/保存/分享/恢复往返：新场景只在真实 WebGL 里才看得出画错，接线错一处只是「下拉里没这项」。' },
  { script: 'check-anime-ui.js', stage: 'behavior',
    why: '晴空绘卷外观族：图库分区卡片、材质与点击反馈按族放行，错接的结果是换肤后画面变平而不报错。' },
  { script: 'check-stanza.js', stage: 'behavior',
    why: '歌词舞台（流光/心象/商籁/凝彩/星诞）：模块大、纯逻辑，最容易在改别处时被无声改坏。' },
  { script: 'check-stanza-sonnet.js', stage: 'behavior',
    why: '商籁：构图数、逐字时间轴、镜头包络都只表现为「画面变得不对」，不报错。' },
  { script: 'check-stanza-tempera.js', stage: 'behavior',
    why: '凝彩：色彩映射与惰性初始化的取消。' },
  { script: 'check-stanza-starborn.js', stage: 'behavior',
    why: '星诞导演。' },
  { script: 'check-sonnet-palette.js', stage: 'behavior',
    why: '调色板纯函数部分（含真实 Chrome 的 --browser 分支留给本地视觉验收）。' },
];

// CI 暂不跑、但本地值得随手跑的无浏览器检查。
const EXTRA = [
  { script: 'check-online-transport.js', why: '在线取流的传输层接缝。' },
  { script: 'check-playlist-views.js', why: '歌单的几种视图形态。' },
  { script: 'check-theme-studio.js', why: '主题工坊参数落盘。' },
  { script: 'check-stage-cinema.js', why: '电影镜头与自由相机。' },
  { script: 'check-stanza-motion.js', why: '歌词动效分面降级。' },
  { script: 'check-lib-empty.js', why: '曲库空态。' },
  { script: 'check-cover-sphere.js', why: '球形封面。' },
  { script: 'check-stage-theme.js', why: '舞台主题。' },
  { script: 'check-ios-theme.js', why: 'iOS 主题。' },
  { script: 'check-creative-prompt.js', why: '创意提示词。' },
];

// 活体检查：需要真实浏览器，默认不跑。qf-issues/narrow-topbar 自行起隔离服务。
// check-lib-row-actions 不在名字里带 browser，但它硬 require playwright，
// 所以显式列进来——按文件名猜会不会漏。
const LIVE_EXTRA = ['check-lib-row-actions.js', 'check-qf-issues.js'];
const LIVE_NOTE = '活体检查需要 Playwright（PLAYWRIGHT_MODULE 或 NODE_PATH）。多数检查还需要运行中的服务；'
  + '清风与窄屏检查自行启动隔离服务，需要先构建 hertz-studio（可设 HERTZ_BIN）。';

// 环境缺件（playwright 没装、服务没起）不是产品坏了。把它们和真实失败分开报，
// 否则本地一句 --extra 会得到一排假红，而假红会让人开始忽略这套检查。
function isEnvironmentMiss(text) {
  return /Cannot find module ['"]playwright['"]|ECONNREFUSED|connect EADDRNOTAVAIL|browserType\.launch/.test(text);
}

function listFiles(dir, ext) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    if (SYNTAX_SKIP.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(full, ext));
    else if (ent.name.endsWith(ext)) out.push(full);
  }
  return out;
}

function syntaxTargets() {
  return SYNTAX_GLOBS.reduce((acc, parts) => acc.concat(listFiles(path.join(ROOT, ...parts), '.js')), []);
}

function run(nodeArgs, label) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, nodeArgs, { cwd: ROOT, encoding: 'utf8' });
  const ms = Date.now() - t0;
  const ok = res.status === 0;
  const tail = String(res.stdout || '').trim().split('\n').slice(-1)[0] || '';
  const errTail = String(res.stderr || '').trim().split('\n').slice(0, 6).join('\n');
  return { ok, ms, label, tail, errTail, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  // --only 在全部已知脚本里找，不被 --extra 挡着：「我就想跑这一条」是排查时的
  // 第一动作，若它必须先知道某条属于哪一组，这个入口就会让人漏跑检查。
  const allSteps = STEPS.concat(EXTRA);
  const steps = argv.includes('--extra')
    ? STEPS.concat(EXTRA)
    : (only ? allSteps : STEPS);
  const wantLive = argv.includes('--live');

  let failures = 0;
  let passed = 0;
  let skipped = 0;
  let ran = 0;

  console.log('阶段 1/4 语法（node --check）');
  const files = syntaxTargets();
  let syntaxBad = 0;
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (only && rel.indexOf(only) < 0) continue;
    const r = run(['--check', f], rel);
    if (!r.ok) {
      syntaxBad += 1;
      failures += 1;
      console.log('  ✗ ' + rel);
      console.log('    ' + r.stderr.trim().split('\n').slice(0, 4).join('\n    '));
    }
  }
  console.log(`  ${files.length} 个文件，${syntaxBad ? syntaxBad + ' 个语法错误（后面几步的意义已经打折）' : '全部通过'}`);

  const stages = [
    ['guard', '阶段 2/4 静态 guard（形状 / 接线 / 禁用词）'],
    ['behavior', '阶段 3/4 行为回归（vm 沙箱跑真实模块）'],
  ];
  // EXTRA 那批只写 why 不写 stage：默认归行为回归。漏了这一句的话它们会被
  // 下面的 filter 静默丢掉——聚合入口自己「跑不到某条检查」是最坏的一种失效。
  const stageOf = (step) => step.stage || 'behavior';
  for (const [stage, stageTitle] of stages) {
    console.log('\n' + stageTitle);
    for (const step of steps.filter((s) => stageOf(s) === stage)) {
      if (only && step.script.indexOf(only) < 0) continue;
      const args = [path.join('scripts', step.script)].concat(step.args || []);
      const r = run(args, step.script);
      ran += 1;
      if (r.ok) {
        passed += 1;
        console.log(`  ✓ ${step.script}  ${r.ms}ms  ${r.tail}`);
      } else if (isEnvironmentMiss(r.stderr + r.stdout)) {
        skipped += 1;
        console.log(`  – ${step.script}  缺环境（playwright 或服务没起），不算产品失败`);
      } else {
        failures += 1;
        console.log(`  ✗ ${step.script}`);
        console.log('    ' + (r.errTail || r.tail || '(无输出)').split('\n').join('\n    '));
        console.log('    这一步在防的失败：' + step.why);
      }
    }
  }

  console.log('\n阶段 4/4 活体检查（真实浏览器 + 运行中的服务）');
  // 环境探测本身就是这一阶段的第一件事：preflight 报的是「机器条件够不够」，
  // 把它当一条普通检查会得到一个假红（它失败是设计好的结论，不是产品缺陷）。
  const live = fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('.js')
      && (LIVE_EXTRA.includes(f)
        || (f.includes('browser') && f !== 'check-browser-preflight.js')))
    .sort();
  if (!wantLive) {
    console.log(`  跳过 ${live.length} 项（要跑加 --live）。${LIVE_NOTE}`);
  } else {
    const gate = run([path.join('scripts', 'check-browser-preflight.js')], 'preflight');
    if (!gate.ok) {
      console.log('  环境探测未通过，本阶段整体跳过（不计失败）：');
      console.log('    ' + (gate.stdout + gate.stderr).trim().split('\n').slice(-4).join('\n    '));
      console.log('    ' + LIVE_NOTE);
    } else {
      console.log(`  ✓ 环境探测通过，逐条跑 ${live.length} 项`);
      for (const f of live) {
        if (only && f.indexOf(only) < 0) continue;
        const r = run([path.join('scripts', f)], f);
        if (r.ok) {
          passed += 1;
          console.log(`  ✓ ${f}  ${r.ms}ms  ${r.tail}`);
        } else if (isEnvironmentMiss(r.stderr + r.stdout)) {
          skipped += 1;
          console.log(`  – ${f}  缺环境（playwright 或服务没起）`);
        } else {
          failures += 1;
          console.log(`  ✗ ${f}\n    ` + (r.errTail || r.tail || '').split('\n').join('\n    '));
        }
      }
    }
  }

  console.log(`\n前端检查聚合：通过 ${passed} 步，失败 ${failures} 步`
    + (skipped ? `，环境缺件跳过 ${skipped} 步` : '')
    + `（默认集合与 ci.yml 的 Frontend contract checks 等价；--extra 的那批 CI 暂不跑）`);
  // 一步都没跑却报绿，是聚合入口最坏的失效：它会让人以为全查过了。
  if (ran === 0) {
    console.error('  ✗ 一条检查都没跑到。--only 的名字给错了？');
    console.error('    可选：' + allSteps.map((s) => s.script.replace('.js', '')).join(' '));
    process.exit(1);
  }
  process.exit(failures ? 1 : 0);
}

main();
