#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
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

const WEB = path.join(__dirname, '..', 'plugin', 'ui');

let failures = 0;
let checks = 0;

function ok(cond, label) {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error('  ✗ ' + label);
  }
}

function eq(a, b, label) {
  checks += 1;
  if (a !== b) {
    failures += 1;
    console.error(`  ✗ ${label}（期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}）`);
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
        def: (block.match(/\bdef:\s*(true|false|-?[\d.]+|'[^']*')/) || [])[1] || null,
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
// 「总开关默认启用」这件事按控件块里的 def 断言，不按相邻两行的排版断言：
// 排版（换行、加 aliases）不该让这个回归守卫变红。
const enabledItem = groups.flatMap((g) => g.items).find((i) => i.key === 'enabled');
ok(enabledItem && enabledItem.def === 'true',
  '舞台滤镜总开关默认启用（修复「拖旋钮无反应」）');
ok(!/paletteMode/.test(controlSrc),
  '已移除无消费方的 paletteMode 死控件');
ok(!/\.disc-img\s*[,{]/.test(readWeb('stage.css')),
  '已移除永不生效的 .disc-img 规则');

// 总强度变量必须被多处消费
ok(consumedVar('--fx-intensity'), '--fx-intensity 总强度有消费方');

// ---------------------------------------------------------------------------
// 5. 行为检查：参数搜索（G5）与调参撤销（G6）
//
// 这两块的故障形态是「点了没报错、只是没反应」，静态断言看不住（第 4 节那种
// 正则守卫恰好是它自己文档里点名的空测试形状）。所以把 stage-control.js 整块
// 装进 vm 沙箱真跑：DOM、定时器、时钟全用替身。
// ---------------------------------------------------------------------------
const vm = require('vm');

function makeStageSandbox() {
  const registry = {};
  const timers = [];
  let clockMs = 1000;
  let focused = null;

  function makeClassList() {
    const set = new Set();
    return {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      contains: (c) => set.has(c),
      toggle: (c, force) => {
        const want = force === undefined ? !set.has(c) : !!force;
        if (want) set.add(c); else set.delete(c);
        return want;
      },
      toString: () => [...set].join(' '),
    };
  }

  function makeEl(tag) {
    const el = {
      tagName: tag || 'div',
      id: '',
      children: [],
      dataset: {},
      attrs: {},
      value: '',
      hidden: false,
      disabled: false,
      textContent: '',
      style: {
        _props: {},
        setProperty(k, v) { this._props[k] = v; },
        removeProperty(k) { delete this._props[k]; },
      },
      handlers: {},
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); },
      getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
      addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
      fire(type, ev) {
        (this.handlers[type] || []).forEach((fn) => fn(ev || { type, target: this, preventDefault() {} }));
      },
      appendChild(c) { c._parent = this; this.children.push(c); return c; },
      append(...cs) { cs.forEach((c) => this.appendChild(c)); },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      // 真3D 面板靠它判断「焦点是不是还在 3D 体内」来决定要不要重织。
      contains(n) {
        let cur = n;
        while (cur) { if (cur === el) return true; cur = cur._parent; }
        return false;
      },
      scrollIntoView() { el.scrolled = true; },
      focus() { focused = el; doc.activeElement = el; },
    };
    el.classList = makeClassList();
    // textContent 按真实 DOM 的语义做：写字符串即替换全部子节点，读时把子树
    // 文本拼回来。桩里若只当普通字段，`box.textContent = ''` 就清不掉旧命中，
    // 断言会看到上一轮的列表。
    Object.defineProperty(el, 'textContent', {
      get() {
        if (el.children.length) return el.children.map((c) => c.textContent).join('');
        return el._text || '';
      },
      set(v) { el._text = String(v); el.children = []; },
    });
    Object.defineProperty(el, 'className', {
      get() { return el.classList.toString(); },
      set(v) {
        el.classList.remove(...[...el.classList.toString()].length ? el.classList.toString().split(/\s+/) : []);
        String(v).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      },
    });
    return el;
  }

  const doc = {
    readyState: 'complete',
    activeElement: null,
    documentElement: Object.assign(makeEl('html'), { dataset: {} }),
    body: makeEl('body'),
    getElementById(id) {
      if (!registry[id]) { registry[id] = makeEl('div'); registry[id].id = id; }
      return registry[id];
    },
    // 只认 markup 里的 id 与 .sc-* 类名：面板打开时要按类找搜索行和副标题，
    // 沙箱里没有真正的 CSS 引擎，按 id 注册表 + classList 反查就够。
    querySelector(sel) {
      if (sel[0] === '#') return doc.getElementById(sel.slice(1));
      if (sel[0] !== '.') return null;
      const cls = sel.slice(1);
      const hit = (el) => el.classList.contains(cls);
      const ids = Object.keys(registry);
      for (const id of ids) {
        const el = registry[id];
        if (hit(el)) return el;
        const stack = [...el.children];
        while (stack.length) {
          const c = stack.pop();
          if (hit(c)) return c;
          stack.push(...c.children);
        }
      }
      return null;
    },
    createElement: (tag) => makeEl(tag),
    createDocumentFragment: () => makeEl('fragment'),
    handlers: {},
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
    dispatchEvent(ev) { (doc.handlers[ev.type] || []).forEach((fn) => fn(ev)); return true; },
  };

  const store = {};
  const sandbox = {
    document: doc,
    window: { matchMedia: () => ({ matches: false }) },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    Date: { now: () => clockMs },
    console,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; Object.assign(this, init || {}); }
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(controlSrc, sandbox, { filename: 'stage-control.js' });

  return {
    sandbox,
    SC: sandbox.window.StageControl,
    // 与模块内 $() 同源：按 id 取（未登记过的先建出来，断言才拿得到面板
    // 只在搜索时才碰的那个结果容器）。
    el: (id) => doc.getElementById(id),
    registry,
    // 控件是 build() 用 createElement 造出来挂进 sc-body 的，不在 id 注册表里，
    // 所以按子树找：id 形如 sc-<组>-<键>，键全局唯一，按后缀取就够。
    nodeOf: (key, tag) => {
      const out = [];
      const walk = (n) => n.children.forEach((c) => { out.push(c); walk(c); });
      walk(registry['sc-body']);
      return out.find((n) => (!tag || n.tagName === tag) && n.id.endsWith('-' + key));
    },
    // 真3D 语境的控件 id 形如 sc-3d-<pref>，宿主是 sc-3d-body（另一棵子树）。
    node3d: (pref, tag) => {
      const out = [];
      const walk = (n) => n.children.forEach((c) => { out.push(c); walk(c); });
      walk(registry['sc-3d-body']);
      return out.find((n) => (!tag || n.tagName === tag) && n.id === 'sc-3d-' + pref);
    },
    // 按可见文本找 3D 面板里的按钮（分段/药丸没有 id）。
    btn3d: (text) => {
      const out = [];
      const walk = (n) => n.children.forEach((c) => { out.push(c); walk(c); });
      walk(registry['sc-3d-body']);
      return out.find((n) => n.tagName === 'button' && n.textContent === text);
    },
    groups3d: () => registry['sc-3d-body'].children
      .filter((c) => c.classList.contains('sc-group'))
      .map((c) => c.children[0].textContent),
    flushTimers() { const t = timers.splice(0); t.forEach((x) => x.fn()); },
    tick(ms) { clockMs += ms; },
    focusedGet: () => focused,
  };
}

function checkSearchAndUndo() {
  console.log('\n参数搜索与撤销（真实模块在 vm 沙箱里跑）');
  const s = makeStageSandbox();
  const SC = s.SC;
  s.SCB = SC;
  SC.init();

  // ---- G5 搜索 ----
  ok(SC.search('暗角').indexOf('vignette') >= 0, '别名「暗角」命中「镜头暗角」');
  ok(SC.search('紫边').indexOf('chroma') >= 0, '别名「紫边」命中「径向色散」');
  ok(SC.search('运镜').indexOf('cinema') >= 0, '别名「运镜」命中「电影镜头」');
  eq(SC.search('zzz-不存在').length, 0, '找不到的词返回空列表');
  ok(SC.search('胶片材质').length > 0, '组名也能当搜索词');

  const search = s.el('sc-search');
  const box = s.el('sc-results');
  search.value = '暗角';
  search.fire('input');
  eq(box.hidden, false, '输入关键词后结果区显示');
  const row = box.children[0];
  ok(/胶片材质 › 镜头暗角/.test(row.children[0].textContent), '结果写「分组 › 参数」');
  eq(row.children[1].textContent, '12%', '结果带当前值');

  row.fire('click');
  const cell = s.nodeOf('vignette')._parent;
  ok(cell.classList.contains('is-found'), '点结果把那颗控件高亮定位');
  eq(s.nodeOf('vignette'), s.focusedGet(), '定位同时把焦点交给控件');
  s.flushTimers();
  ok(!cell.classList.contains('is-found'), '高亮会自己收掉，不永久留在屏上');

  search.value = 'zzz-不存在';
  search.fire('input');
  ok(/没有匹配的参数/.test(box.children[0].textContent), '找不到时给明确反馈而不是空白面板');
  search.value = '';
  search.fire('input');
  eq(box.hidden, true, '清空搜索收起结果');
  eq(SC.values().vignette, 12, '搜一圈不会改到任何参数值');

  // ---- G6 撤销 ----
  const den = s.nodeOf('density', 'input');
  const before = SC.values().density;
  den.fire('pointerdown');
  den.value = '150'; den.fire('input');
  den.value = '180'; den.fire('input');
  den.fire('change');
  eq(SC.historyDepth(), 1, '一次拖动只算一条历史（不是每帧一条）');
  eq(SC.values().density, 180, '拖动落到参数表');
  SC.undo();
  eq(SC.values().density, before, '撤销回到拖动之前');
  eq(den.value, String(before), '撤销把滑块本身也复位');
  eq(SC.historyDepth(), 0, '撤销后栈空');

  const snapshot = SC.values();
  const it = s.nodeOf('intensity', 'input');
  it.fire('pointerdown'); it.value = '140'; it.fire('input'); it.fire('change');
  const sw = s.nodeOf('cinema', 'button');
  sw.fire('click');
  eq(SC.historyDepth(), 2, '开关与滑块各算一笔');
  ok(SC.values().cinema !== snapshot.cinema, '开关确实改了');
  SC.undo();
  eq(SC.values().cinema, snapshot.cinema, '撤销只回最后一步（开关）');
  eq(SC.values().intensity, 140, '没参与那一步的键保持不动');

  // 一次按住方向键的重复 keydown 算一笔，keyup 结束手势。两次都要是真实变化：
  // 把 100 调成 100 不该产出一条历史，那样这个断言会退化成空测。
  const snap2 = SC.values();
  const depthBeforeBurst = SC.historyDepth();
  den.fire('keydown', { key: 'ArrowRight' }); den.value = '110'; den.fire('input'); den.fire('change');
  s.tick(200);
  den.fire('keydown', { key: 'ArrowRight' }); den.value = '115'; den.fire('input'); den.fire('change');
  den.fire('keyup', { key: 'ArrowRight' });
  const depthAfterBurst = SC.historyDepth();
  eq(depthAfterBurst, depthBeforeBurst + 1, '一次按住方向键只占一条历史');
  SC.undo();
  eq(SC.values().density, snap2.density, '撤销一次回到整段之前（不是只退最后一下）');

  const dNoop = SC.historyDepth();
  den.fire('keydown'); den.value = String(SC.values().density); den.fire('input'); den.fire('change');
  eq(SC.historyDepth(), dNoop, '把值调回原样不产出一条假历史');

  // 两次独立手势算两笔：不然撤一次会退得比用户预期的远。
  const dBefore = SC.historyDepth();
  den.fire('keydown'); den.value = '120'; den.fire('input'); den.fire('change');
  const mid = SC.values().density;
  s.tick(1000);
  den.fire('keydown'); den.value = '130'; den.fire('input'); den.fire('change');
  eq(SC.historyDepth(), dBefore + 2, '两次独立调整算两笔');
  SC.undo();
  eq(SC.values().density, mid, '撤销只退回上一笔，不是一路退到段首');

  // 恢复默认 = 一笔，并能整段退回。
  const preReset = SC.values();
  s.el('sc-reset').fire('click');
  ok(SC.values().vignette === 12 && SC.values().density === 100, '恢复默认把参数落回出厂值');
  const depthWithReset = SC.historyDepth();
  SC.undo();
  eq(SC.values().density, preReset.density, '撤销一次把整段恢复默认退回去');
  eq(SC.historyDepth(), depthWithReset - 1, '恢复默认只占一条历史');

  // 外部命令通道不进视觉栈（皮肤/预设下发不该被用户的 Ctrl+Z 撤掉）。
  const d3 = SC.historyDepth();
  SC.set({ grain: 20 });
  eq(SC.values().grain, 20, '外部 set 生效');
  eq(SC.historyDepth(), d3, '外部 set 不进撤销栈');

  // 有界：45 笔独立调整只留 40 条。
  for (let i = 0; i < 45; i += 1) {
    s.tick(1000);
    den.fire('keydown'); den.value = String(20 + i); den.fire('input'); den.fire('change');
  }
  ok(SC.historyDepth() <= 40, `历史有界（实测 ${SC.historyDepth()} 条）`);

  // 关面板把搜索清干净：下次进来不该留着上次的命中列表。
  SC.close();
  eq(s.el('sc-results').hidden, true, '关面板收起搜索结果');
}

// ---------------------------------------------------------------------------
// 6. 真3D 语境契约
//
// 控制舱原来只有一套「普通舞台 CSS 变量旋钮」，而其中镜头光学 / 胶片材质那几组
// 在真3D 舞台上全是死旋钮 —— 拖得动、画面毫无反应。现在两套语境互斥显示，
// 真3D 侧直接读写 Stage3D 偏好。这一节钉三件事：
//   a. 量程：滑块上界必须等于 Stage3D 里那道 clamp 的上界（踩过：reactivity
//      默认 1.35 > 1，按「缩放系数」推算会顶到轨道上限，一拖就把值悄悄写小）；
//   b. 层级：控制舱要能浮在三维舞台之上，否则真3D 里根本打不开；
//   c. 写回节奏：拖动只生效、松手才落库（与舞台自带滑块同一节奏）。
// ---------------------------------------------------------------------------
const s3src = readWeb('stage3d.js');
const html = readWeb('index.html');
const stageCss = readWeb('stage.css');
const s3css = readWeb('stage3d.css');

// —— a. 量程 ——
const sliderCalls = [...controlSrc.matchAll(/slider3d\('([^']*)',\s*'([^']+)',\s*([\d.]+)/g)]
  .map((m) => ({ label: m[1], pref: m[2], max: Number(m[3]) }));
ok(sliderCalls.length >= 4, `真3D 滑块可解析（实测 ${sliderCalls.length} 个）`);

function clampUpper(pref) {
  // stage3d.js 里形如 `if (…) reactivity = clamp(num(value.reactivity, 1.35), 0, 2);`
  // —— 赋值不在行首（前面有 if 条件），所以只能锚 `pref = clamp(` 本身。
  const m = s3src.match(new RegExp('\\b' + pref + '\\s*=\\s*clamp\\([^\\n]*?,\\s*0,\\s*([\\d.]+)\\)'));
  return m ? Number(m[1]) : null;
}
for (const c of sliderCalls) {
  const upper = clampUpper(c.pref);
  ok(upper !== null, `${c.pref}: 在 stage3d.js 里能找到 clamp 上界`);
  eq(c.max, upper, `${c.pref}（${c.label}）滑块上界 = Stage3D clamp 上界`);
}

// —— b. 层级 ——
const zCtl = Number((stageCss.match(/\.stage-ctl\s*\{[\s\S]{0,400}?z-index:\s*(\d+)/) || [])[1] || 0);
const z3d = Number((s3css.match(/\.s3d\s*\{[\s\S]{0,900}?z-index:\s*(\d+)/) || [])[1] || 0);
ok(z3d > 0, `三维舞台根层 z-index 可解析（实测 ${z3d}）`);
ok(zCtl > z3d, `控制舱 z=${zCtl} 浮在三维舞台 z=${z3d} 之上（真3D 里也打得开）`);

// —— 语境跟随舞台：二维/三维各看各的，不提供手动互切 ——
ok(!/id="sc-context-(flat|3d)"/.test(html), '控制舱不再提供手动语境分段（两个场景池不混在一屏）');
ok(/function followStage\(/.test(controlSrc) && /MutationObserver/.test(controlSrc),
  '进出三维舞台时语境自动跟随');
ok(/id="sc-3d-body"[^>]*\shidden/.test(html) || /id="sc-3d-body"[^>]*hidden/.test(html),
  '真3D 宿主默认收起（不抢普通舞台首屏）');

// —— SCHEMA_3D 的每个取值都必须被 Stage3D.configure 真正接受 ——
function block3d(name) {
  const from = controlSrc.indexOf('var SCHEMA_3D');
  const seg = controlSrc.slice(from, controlSrc.indexOf('var context'));
  const start = seg.indexOf(name + ':');
  if (start < 0) return [];
  // 闭合是行首缩进的 `],`——数组里每行的 `'],` 更早出现，按字符串找会
  // 把清单截成第一项（来源清单因此只剩 'immersive'，白名单断言就空转了）。
  const close = seg.slice(start).match(/\n\s*\],/);
  const end = close ? start + close.index : seg.length;
  return [...seg.slice(start, end).matchAll(/\['([^']+)',/g)].map((m) => m[1]);
}
const srcVals = block3d('sources');
ok(srcVals.length >= 3, `真3D 来源清单可解析（实测 ${srcVals.length} 项）`);
for (const v of srcVals) {
  ok(new RegExp("value\\.sceneSource === '" + v + "'").test(s3src),
    `来源 ${v} 被 Stage3D.configure 白名单接受`);
}
for (const v of block3d('layouts')) {
  ok(new RegExp("'focus',\\s*'sleeve',\\s*'single'").test(s3src)
    && ['focus', 'sleeve', 'single'].indexOf(v) >= 0,
    `布局 ${v} 被 Stage3D.configure 接受`);
}
ok(!/carriers/.test(controlSrc), '镜台载体分段必须随镜台一并移除');
// 布尔药丸：configure 必须按 boolean 收
for (const k of ['lyrics', 'coastInteract', 'zodiacField', 'zodiacInteract', 'animeMirror']) {
  ok(new RegExp("typeof value\\." + k + " === 'boolean'").test(s3src),
    `布尔偏好 ${k} 被 configure 按 boolean 收`);
}

// —— 控件语言：新样式要有规则，旧样式不留残骸 ——
ok(/\.sc-pill\s*\{/.test(stageCss), '.sc-pill 有样式定义');
ok(/\.sc-pill\.on\s*\{[\s\S]{0,300}?--accent/.test(stageCss), '.sc-pill ON 态走 accent（一眼可读）');
ok(/\.sc-seg-btn\.is-on\s*\{[\s\S]{0,300}?--accent/.test(stageCss), '.sc-seg-btn 当前段走 accent');
ok(/\.sc-seg-btn\.is-on\s*\{[\s\S]{0,300}?--accent/.test(stageCss), '来源分段与布局分段共用同一套高亮');
ok(!/\.sc-switch\b/.test(stageCss) && !/'sc-switch'|"sc-switch"/.test(controlSrc),
  '旧小开关 .sc-switch 已彻底移除（CSS 与 JS 两侧）');
// 3D 面板的引导行依赖 .sc-note 可见；被 display:none 掉等于写了没人看得到。
const noteRule = (stageCss.match(/\.sc-note\s*\{[^}]*\}/) || [''])[0];
ok(noteRule && !/display:\s*none/.test(noteRule), '.sc-note 可见（3D 引导行不是死文本）');
// 时刻标签不在这里重写阈值
ok(/coastTodLabel/.test(controlSrc) && /coastTodLabel:\s*coastTodLabel/.test(s3src),
  '海岸时刻标签复用 Stage3D 导出的 coastTodLabel（阈值只有一处）');

// —— 写回路径 ——
ok(/S3\.configure\(patch\)/.test(controlSrc) && /\bS3\.save\b/.test(controlSrc),
  '真3D 写回走 Stage3D.configure + save');

// —— inert：三维舞台开舱必答题 ——
// stage3d open() 会把 body 直属子节点全部 inert。inert 元素照常绘制但整体
// 退出命中测试——控制舱被静音后，z-index 提到多高都点不进去（canvas 拦下
// 全部指针事件），而且不报错，是「真3D 没控制」最隐蔽的一半。
const s3dOpenFn = s3src.slice(
  s3src.indexOf('function open(stageId)'), s3src.indexOf('function close()'));
ok(s3dOpenFn.length > 200, 'stage3d open() 可切片');
ok(/node\.id === 'stage-ctl'/.test(s3dOpenFn),
  '三维舞台静音背景时跳过控制舱（inert 会让它点不进去）');
const setOpenFn = controlSrc.slice(
  controlSrc.indexOf('function setOpen(next)'), controlSrc.indexOf('function reset()'));
ok(/panel\.inert = !want/.test(setOpenFn),
  '控制舱自己管理 inert：关着的抽屉 Tab 落不进去');
ok(/id="stage-ctl"[^>]*\sinert/.test(html),
  '控制舱初始 inert（首帧到首次打开之间不可误触）');

// ---------------------------------------------------------------------------
// 7. 真3D 语境行为（真实模块 + 替身 Stage3D 在 vm 沙箱里跑）
// ---------------------------------------------------------------------------
function fakeStage3D(overrides) {
  const prefs = Object.assign({
    sceneSource: 'coast',
    motion: 0.65, bloom: 0.8, reactivity: 1.35,
    lyrics: true, layout: 'focus',
    coastTod: 0, coastInteract: true,
    zodiacField: true, zodiacInteract: true,
    animeScene: 'anime-coast', animeMirror: false,
  }, overrides || {});
  const calls = { configure: [], save: 0 };
  return {
    prefs, calls,
    isActive: () => true,
    preferences: () => JSON.parse(JSON.stringify(prefs)),
    coastTodLabel: (v) => (v < 0.22 ? '黄昏' : v < 0.42 ? '入夜' : v < 0.6 ? '午夜' : v < 0.8 ? '凌晨' : '黎明'),
    configure(patch) {
      calls.configure.push(JSON.parse(JSON.stringify(patch)));
      Object.keys(patch).forEach((k) => { prefs[k] = patch[k]; });
    },
    save() { calls.save += 1; },
  };
}

function openWith(overrides) {
  const s = makeStageSandbox();
  const fake = fakeStage3D(overrides);
  s.sandbox.window.Stage3D = fake;
  s.SC.init();
  s.SC.open();
  return { s, fake };
}

function check3DContext() {
  console.log('\n真3D 语境（真实模块 + 替身 Stage3D 在 vm 沙箱里跑）');

  // —— 语境自动跟随 ——
  {
    const { s } = openWith({ sceneSource: 'coast' });
    eq(s.SC.context(), '3d', '海岸公路下打开 → 真3D 语境');
    eq(s.el('sc-body').hidden, true, '真3D 语境下普通旋钮收起（不留死旋钮）');
    eq(s.el('sc-3d-body').hidden, false, '真3D 宿主上屏');
    ok(s.el('stage-ctl').classList.contains('is-3d'), '面板挂 is-3d（皮肤可据此排版）');
    const groups = s.groups3d();
    ok(groups.indexOf('舞台来源') >= 0 && groups.indexOf('镜头与画面') >= 0
      && groups.indexOf('来源专属') >= 0, `真3D 三组齐全（实测 ${groups.join('/')}）`);
  }
  {
    // 普通舞台来源（创意编排 / 动画绘景）没有三维镜头 → 仍是普通舞台语境
    const { s } = openWith({ sceneSource: 'creative' });
    eq(s.SC.context(), 'flat', '创意编排下打开 → 普通舞台语境');
    eq(s.el('sc-body').hidden, false, '普通舞台语境下旋钮照常显示');
  }

  // —— 语境只跟随舞台，不能手动把三维来源拉到二维首屏 ——
  {
    const { s, fake } = openWith({ sceneSource: 'coast' });
    eq(s.SC.context(), '3d', '海岸公路下打开 → 真3D 语境');
    fake.isActive = () => false;
    s.SC.close();
    s.SC.open();
    eq(s.SC.context(), 'flat', '退出三维舞台后重开 → 二维语境（来源清单不跟过来）');
  }

  // —— 离散动作：当场生效并落库 ——
  {
    const { s, fake } = openWith({ sceneSource: 'coast' });
    const before = fake.calls.save;
    s.btn3d('星座').fire('click');
    const last = fake.calls.configure[fake.calls.configure.length - 1];
    eq(last && last.sceneSource, 'zodiac', '点来源分段写 sceneSource');
    eq(fake.calls.save, before + 1, '离散动作（切来源）当场落库');
    // 来源切换后「来源专属」要重织：星座的星云/交互出现在面板里
    ok(!!s.btn3d('背景星云') && !!s.btn3d('交互旋转（拖拽/滚轮）'),
      '切到星座后来源专属重织出该来源的控件');
  }

  // —— 滑块：量程 / 节奏 / 不进撤销栈 ——
  {
    const { s, fake } = openWith({ sceneSource: 'coast' });
    const r = s.node3d('reactivity', 'input');
    ok(!!r, '律动滑块已生成');
    // 1.35 / 2 → 68%。按「缩放系数」推算会算出 270（顶格），这条就是那次的守卫。
    eq(r.value, '68', '律动默认 1.35 显示 68%（按 0..2 上界，不是顶格满值）');
    ok(Number(r.value) <= 100, `滑块读数落在 0..100（实测 ${r.value}）`);

    const nSave = fake.calls.save;
    r.value = '100'; r.fire('input');
    const wrote = fake.calls.configure[fake.calls.configure.length - 1];
    eq(wrote && wrote.reactivity, 2, '滑块满格写入上界 2');
    eq(fake.calls.save, nSave, '拖动中不落库（每帧一次 IPC 会把拖动拖成卡顿）');
    r.value = '50'; r.fire('input');
    r.fire('change');
    eq(fake.calls.save, nSave + 1, '松手（change）只落库一次');
    eq(fake.calls.configure[fake.calls.configure.length - 1].reactivity, 1, '落库值 = 50% × 2');

    // 真3D 的状态属主是 Stage3D 偏好表，不该混进普通舞台的撤销栈
    const depth = s.SC.historyDepth();
    const pill = s.btn3d('显示歌词');
    pill.fire('click');
    eq(s.SC.historyDepth(), depth, '真3D 调整不进普通舞台撤销栈');
    eq(fake.calls.configure[fake.calls.configure.length - 1].lyrics, false, '歌词药丸写布尔');
    ok(pill.classList.contains('on') === false, '药丸 ON 态跟着落下');
  }

  // —— 时刻标签：显示「黄昏/午夜」而不是百分比 ——
  {
    const { s } = openWith({ sceneSource: 'coast', coastTod: 0.5 });
    const tod = s.node3d('coastTod', 'input');
    eq(tod.value, '50', '海岸时刻滑块位置正确');
    const cell = tod._parent;
    ok(/午夜/.test(cell.textContent), `海岸时刻显示时刻名（实测 ${cell.textContent}）`);
  }

  // —— 沉浸声场：来源专属给的是引导而不是空白 ——
  {
    const { s } = openWith({ sceneSource: 'immersive' });
    ok(/场景坞/.test(s.el('sc-3d-body').textContent),
      '沉浸声场的来源专属给出引导（指向场景坞），不是空白');
  }
}

check3DContext();
checkSearchAndUndo();

console.log(`\n舞台控制契约：${checks} 项检查，` +
  (failures ? `${failures} 个失败` : '全部通过'));
process.exit(failures ? 1 : 0);
