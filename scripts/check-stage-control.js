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

  // 键盘连按（同键、间隔在合并窗内）算一笔。两次都要是真实变化：
  // 把 100 调成 100 不该产出一条历史，那样这个断言会退化成空测。
  const snap2 = SC.values();
  const depthBeforeBurst = SC.historyDepth();
  den.fire('keydown'); den.value = '110'; den.fire('input'); den.fire('change');
  s.tick(200);
  den.fire('keydown'); den.value = '115'; den.fire('input'); den.fire('change');
  const depthAfterBurst = SC.historyDepth();
  eq(depthAfterBurst, depthBeforeBurst + 1, '合并窗内的同键连按只占一条历史');
  SC.undo();
  eq(SC.values().density, snap2.density, '撤销一次回到整段之前（不是只退最后一下）');

  const dNoop = SC.historyDepth();
  den.fire('keydown'); den.value = String(SC.values().density); den.fire('input'); den.fire('change');
  eq(SC.historyDepth(), dNoop, '把值调回原样不产出一条假历史');

  // 超出合并窗的两次同键调整算两笔：不然撤一次会退得比用户预期的远。
  const dBefore = SC.historyDepth();
  den.fire('keydown'); den.value = '120'; den.fire('input'); den.fire('change');
  const mid = SC.values().density;
  s.tick(1000);
  den.fire('keydown'); den.value = '130'; den.fire('input'); den.fire('change');
  eq(SC.historyDepth(), dBefore + 2, '相隔超出合并窗的两次调整算两笔');
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

checkSearchAndUndo();

console.log(`\n舞台控制契约：${checks} 项检查，` +
  (failures ? `${failures} 个失败` : '全部通过'));
process.exit(failures ? 1 : 0);
