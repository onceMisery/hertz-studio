#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// CSS 令牌契约检查（零依赖，静态扫描，不需要浏览器）。
//
// 为什么需要它：style.css 与 stage.css 都在 :root 上声明变量，stage.css 在
// <link> 里排在 style.css 之后，**同优先级整块覆盖**。一旦两个文件对同名令牌
// 的约定不一致（style.css 的 --glass-border 是 `1px solid <color>` 完整简写、
// --glass-shadow 是三层阴影列表；曾经 stage.css 写成裸色值），覆盖后
// style.css 里的 `border: var(--glass-border)` / `box-shadow: var(--glass-shadow)`
// 会变成非法值被浏览器整条丢弃，而 stage.css 自己的组件因为拼出了
// `1px solid <color>` / `0 8px 28px <color>` 反而侥幸正常 —— 页面不会报错、
// 不崩、也不缺元素，只是「舞台和播放条有描边投影、顶栏/导航轨/曲库面板没有」。
// 这种静默降级只能靠断言兜住。
//
// 用法: node scripts/check-css-tokens.js [web 目录]

'use strict';

const fs = require('fs');
const path = require('path');

const webDir = process.argv[2] || path.join(__dirname, '..', 'crates', 'vmusicd', 'web');

// 共享令牌：全站只有一个定义处，即 style.css 的 :root。
// stage.css 只允许声明自己独占的 --stage-*。
const SHARED_TOKENS = [
  '--glass-bg',
  '--glass-border',
  '--glass-shadow',
  '--glass-shadow-glow',
  '--glass-blur',
  '--hover',
];
const OWNER_FILE = 'style.css';

// 实心按钮的 hover 契约：.ctrl:hover / .btn:hover 这类基础态 hover 的特异性
// 可能高于实心态自身，若 hover 规则只写 box-shadow 而不重新声明 background，
// 实心底就会被 --hover 的浅色底盖掉（图标与底色同色 => 直接隐身）。
const SOLID_HOVER_CONTRACT = [
  {
    file: 'style.css',
    selector: '.ctrl-primary:hover',
    must: ['background', 'color'],
    why: '主播放键是实心白圆盘；.ctrl:hover 特异性 (0,2,0) 高于 .ctrl-primary 的 (0,1,0)',
  },
];

// 图标按钮的尺寸契约：复用 .btn-pill 外形、但内容只有一个图标的按钮，
// 必须用**复合选择器**把内边距与尺寸钉死。单类选择器 `.bar-pin-toggle` 与
// `.btn-pill` 特异性相同，只要它排在 .btn-pill 之前，`padding: 0` 就会被静默
// 盖回 `7px 14px`——34px 宽的按钮只剩 4px 内容盒，18px 的 svg 作为 flex 子项
// 被压到最小尺寸（受默认 2:1 内在比例约束），symbol 跟着缩到 0.375 倍。
// 页面不报错、不崩、元素也在，只是那个按钮变成一个空心圆里一小撮看不清的东西。
const ICON_BUTTON_CONTRACT = [
  {
    file: 'style.css',
    selector: '.btn-pill.bar-pin-toggle',
    must: ['width', 'height', 'padding'],
    why: '它是纯图标按钮。padding 输给 .btn-pill 会把图标压成亚像素，按钮看起来"空了"',
  },
];

// 音源 chip 的尺寸契约（online.css）：登录弹窗顶部的音源选择条里，
// 已登录的那块（.is-in）内部是「头像 + 昵称」两个子元素，而音源条本身是 flex 行、
// 默认 align-items:stretch。于是只要 .qr-source 少了 display:flex：
//   · 头像（display:flex 的块级元素）和昵称上下堆叠 → 这块被撑到 53px；
//   · 同一行其它 chip 被 stretch 拉着一样高（54px）；换行到第二行的 chip
//     没人拉，只有 31px —— 表现就是"汽水音乐那块明显比别的小"。
// 三个声明各自负责一件事，缺一个就是一片歪的 chip，且页面不报错、元素也在。
const QR_SOURCE_CONTRACT = {
  file: 'online.css',
  selector: '.qr-source',
  must: ['display', 'align-items', 'justify-content', 'height'],
  valueMust: { display: 'flex', 'align-items': 'center', height: 'px' },
  why: 'display:flex 让头像与昵称并排、height 让带头像的块与纯文字块一样高；缺了就是一片高度不齐的 chip',
};

const LENGTH_RE = /\d*\.?\d+(px|rem|em|%|vh|vw)\b/;
const BORDER_STYLE_RE = /\b(solid|dashed|dotted|double|groove|ridge|inset|outset)\b/;

// 主题色样本的构成契约：色点（菜单 .theme-dot）与色块（设置 .theme-swatch）
// 是同一个东西的两种尺寸，必须由**同一条规则**画出「盘心 = 主题底色 + 外环 =
// 主色→次色」。两处各写一份就会漂移（历史上就是改了色点忘了色块），只画主色渐变
// 则会把「矿石黑（默认）」画成亮青球——主题名说的是底色，样本却只剩主色，页面
// 不报错、元素也在，只是"示例看起来不是黑色的"。两层裁剪盒缺一层，环和心就没了。
//
// 盘心/外环吃的是 --t-bg / --t-accent / --t-accent-2 三个别名，由 app.js 的
// themeDotStyle() 现喂；那里漏一个不会报错，只会静静退回 var(--bg)（所有样本
// 变成同一个颜色），所以要顺着别名把生产侧也钉住。
const THEME_SAMPLE_CONTRACT = {
  file: 'stage.css',
  selector: '.theme-dot, .theme-swatch',
  must: ['background-image', 'background-clip'],
  boxes: ['content-box', 'padding-box'],
  producer: {
    file: 'app.js',
    fn: 'themeDotStyle',
    aliases: { '--t-bg': '--bg', '--t-accent': '--accent', '--t-accent-2': '--accent-2' },
  },
  why: '盘心漏掉底色会退回 var(--bg)（样本同色），裁剪盒少一层就画不出"环 + 心"；分开写会漂移',
};

function stripComments(src) {
  // 用等量空白替换注释，保留换行，使索引与原文对齐、行号可直接换算
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (src[i] === '\n') line++;
  return line;
}

// 选择器组可能跨行书写，比对前把空白归一，免得改个换行就让契约找不到规则
function normSelector(sel) {
  return sel.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();
}

// 扫出所有非嵌套规则块。@media 这类只起包裹作用的外层块因为 `{` 紧跟 `{`
// 不会被匹配成规则，其内部规则仍然会被逐个扫到。
function scanRules(clean) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    // m.index 落在选择器之前的空白上（上一块结尾到本块之间都算 `[^{}]+`），
    // 要跳过前导空白才是指向选择器本身的偏移
    const lead = m[1].search(/\S/);
    rules.push({
      selector: m[1].trim(),
      body: m[2],
      selectorIndex: m.index + (lead < 0 ? 0 : lead),
      bodyIndex: m.index + m[1].length + 1,
    });
  }
  return rules;
}

// 返回带绝对偏移的声明列表，偏移用于把问题定位到具体那一行（而不是块首）
function declarations(body, base) {
  const out = [];
  let pos = 0;
  for (const chunk of body.split(';')) {
    const lead = chunk.search(/\S/);
    if (lead >= 0) {
      const text = chunk.trim();
      const i = text.indexOf(':');
      out.push({
        prop: (i < 0 ? text : text.slice(0, i).trim()).toLowerCase(),
        value: i < 0 ? '' : text.slice(i + 1).trim(),
        index: base + pos + lead,
      });
    }
    pos += chunk.length + 1; // +1 补回分隔用的分号
  }
  return out;
}

const problems = [];
const checked = { fields: 0, rules: 0 };

const files = fs
  .readdirSync(webDir)
  .filter((f) => f.endsWith('.css') && !f.endsWith('.bak'));

for (const file of files) {
  const raw = fs.readFileSync(path.join(webDir, file), 'utf8');
  const clean = stripComments(raw);
  const rules = scanRules(clean);
  checked.rules += rules.length;

  for (const rule of rules) {
    const ruleLine = lineOf(clean, rule.selectorIndex);
    const decls = declarations(rule.body, rule.bodyIndex);

    for (const d of decls) {
      const line = lineOf(clean, d.index);

      // --- 契约 A：共享令牌只能由 style.css 的 :root 定义 ---
      if (SHARED_TOKENS.includes(d.prop)) {
        checked.fields++;
        if (file !== OWNER_FILE || rule.selector !== ':root') {
          problems.push({
            file,
            line,
            rule: `共享令牌 ${d.prop} 定义在 ${file} 的 \`${rule.selector}\`（块首 ${ruleLine} 行）`,
            why: `它由 ${OWNER_FILE} 的 :root 独占定义；本文件后加载会整块覆盖，导致 ${OWNER_FILE} 里的用法静默失效`,
          });
        }
      }

      // --- 契约 B：阴影令牌已是完整列表，不能再拼接长度 ---
      if (d.prop === 'box-shadow' && /var\(\s*--glass-shadow(-\w+)?\s*\)/.test(d.value)) {
        checked.fields++;
        const residue = d.value.replace(/var\([^)]*\)/g, ' ');
        if (LENGTH_RE.test(residue)) {
          problems.push({
            file,
            line,
            rule: `box-shadow 里把长度和 var(--glass-shadow*) 拼在一起: ${d.value.replace(/\s+/g, ' ')}`,
            why: '该令牌本身已是完整阴影列表（可能多段），拼接会产出非法值、整条声明被丢弃',
          });
        }
      }

      // --- 契约 C：描边令牌已是完整简写，不能再补 1px solid ---
      if (d.prop.startsWith('border') && d.value.includes('var(--glass-border)')) {
        checked.fields++;
        const residue = d.value.replace(/var\([^)]*\)/g, ' ');
        if (LENGTH_RE.test(residue) || BORDER_STYLE_RE.test(residue)) {
          problems.push({
            file,
            line,
            rule: `border 简写与 var(--glass-border) 重复: ${d.value.replace(/\s+/g, ' ')}`,
            why: '该令牌本身已是 "1px solid <color>"，重复书写会变成非法值（border 风格被重置为 none）',
          });
        }
      }

      // --- 契约 D：实心按钮的 hover 必须重新声明底色 ---
      const contract = SOLID_HOVER_CONTRACT.find(
        (c) => c.file === file && c.selector === rule.selector
      );
      if (contract) {
        checked.fields++;
        const props = decls.map((x) => x.prop);
        const missing = contract.must.filter((p) => !props.includes(p));
        if (missing.length) {
          problems.push({
            file,
            line,
            rule: `${contract.selector} 缺少 ${missing.join(' / ')}`,
            why: contract.why,
          });
        }
      }

      // --- 契约 E：图标按钮必须自带尺寸（复合选择器） ---
      const iconBtn = ICON_BUTTON_CONTRACT.find(
        (c) => c.file === file && c.selector === rule.selector
      );
      if (iconBtn) {
        checked.fields++;
        iconBtn.found = true;
        const props = decls.map((x) => x.prop);
        const missing = iconBtn.must.filter((p) => !props.includes(p));
        if (missing.length) {
          problems.push({
            file,
            line,
            rule: `${iconBtn.selector} 缺少 ${missing.join(' / ')}`,
            why: iconBtn.why,
          });
        }
      }

      // --- 契约 G：音源 chip 必须自带 flex 与固定高度 ---
      // 与 F 同理：这些是整条规则的属性，跟着每个声明重复报没有意义
      if (
        !QR_SOURCE_CONTRACT.found &&
        file === QR_SOURCE_CONTRACT.file &&
        normSelector(rule.selector) === QR_SOURCE_CONTRACT.selector
      ) {
        checked.fields++;
        QR_SOURCE_CONTRACT.found = true;
        const props = decls.map((x) => x.prop);
        const missing = QR_SOURCE_CONTRACT.must.filter((p) => !props.includes(p));
        if (missing.length) {
          problems.push({
            file,
            line,
            rule: `${QR_SOURCE_CONTRACT.selector} 缺少 ${missing.join(' / ')}`,
            why: QR_SOURCE_CONTRACT.why,
          });
        }
        // 取值也要看：`display:block` 同样是"有这个属性"，但头像还是会堆在上面
        for (const [prop, want] of Object.entries(QR_SOURCE_CONTRACT.valueMust)) {
          const got = decls.filter((x) => x.prop === prop).map((x) => x.value).join(' ');
          if (got && !got.includes(want)) {
            problems.push({
              file,
              line,
              rule: `${QR_SOURCE_CONTRACT.selector} 的 ${prop} 取值为 "${got}"，应含 "${want}"`,
              why: QR_SOURCE_CONTRACT.why,
            });
          }
        }
      }

      // --- 契约 F：主题色样本的构成（环 + 心） ---
      // 一个规则只判一次：这些检查是整条规则的属性，跟着每个声明重复报没有意义
      if (
        !THEME_SAMPLE_CONTRACT.found &&
        file === THEME_SAMPLE_CONTRACT.file &&
        normSelector(rule.selector) === THEME_SAMPLE_CONTRACT.selector
      ) {
        checked.fields++;
        THEME_SAMPLE_CONTRACT.found = true;
        const props = decls.map((x) => x.prop);
        const missing = THEME_SAMPLE_CONTRACT.must.filter((p) => !props.includes(p));
        if (missing.length) {
          problems.push({
            file,
            line,
            rule: `${THEME_SAMPLE_CONTRACT.selector} 缺少 ${missing.join(' / ')}`,
            why: THEME_SAMPLE_CONTRACT.why,
          });
        }
        // 两个裁剪盒都要在：每个属性各一条声明时只写一个也会被拆开看，这里按
        // 属性归并全部取值再判，写法怎么变都认。
        const boxes = decls
          .filter((x) => x.prop === 'background-clip')
          .flatMap((x) => x.value.replace(/\s*,\s*/g, ' ').split(/\s+/));
        const lostBox = THEME_SAMPLE_CONTRACT.boxes.filter((b) => !boxes.includes(b));
        if (boxes.length && lostBox.length) {
          problems.push({
            file,
            line,
            rule: `background-clip 少了 ${lostBox.join(' / ')}（实际：${boxes.join(' ')}）`,
            why: '外环裁进内边距盒、盘心裁进内容盒，缺一层就画不出"环 + 心"',
          });
        }
        if (!/var\(\s*--t-/.test(rule.body)) {
          problems.push({
            file,
            line,
            rule: '主题色样本规则里没有任何 var(--t-*) 别名',
            why: '环与心都靠 --t-bg / --t-accent / --t-accent-2 上色，写死了就不是主题样本了',
          });
        }
        THEME_SAMPLE_CONTRACT.body = rule.body;
        THEME_SAMPLE_CONTRACT.line = ruleLine;
      }
    }
  }
}

// 契约 E / G 的规则本身不在了也要报：改回单类选择器、或者把规则删掉，
// 同样会踩回那两个坑（一个是图标压成亚像素，一个是 chip 高度不齐）
for (const c of [...ICON_BUTTON_CONTRACT, QR_SOURCE_CONTRACT]) {
  if (!c.found) {
    problems.push({
      file: c.file,
      line: 1,
      rule: `找不到规则 \`${c.selector}\``,
      why: `${c.why}；这条规则必须保留`,
    });
  }
}

// 契约 F：规则要在（顺带把别名清单交给生产侧核对），两边的令牌名要对得上
if (!THEME_SAMPLE_CONTRACT.found) {
  problems.push({
    file: THEME_SAMPLE_CONTRACT.file,
    line: 1,
    rule: `找不到主题色样本规则 \`${THEME_SAMPLE_CONTRACT.selector}\``,
    why: `${THEME_SAMPLE_CONTRACT.why}；这两个选择器必须合并在同一条规则里`,
  });
} else {
  const aliases = [
    ...new Set(
      (THEME_SAMPLE_CONTRACT.body.match(/var\(\s*--t-[\w-]+/g) || []).map((s) =>
        s.replace(/^var\(\s*/, '')
      )
    ),
  ];
  if (!aliases.length) {
    problems.push({
      file: THEME_SAMPLE_CONTRACT.file,
      line: THEME_SAMPLE_CONTRACT.line,
      rule: '主题色样本规则没有引用任何 --t-* 别名',
      why: '环与心都靠这些别名上色',
    });
  }

  const p = THEME_SAMPLE_CONTRACT.producer;
  let producerSrc = '';
  try {
    producerSrc = fs.readFileSync(path.join(webDir, p.file), 'utf8');
  } catch (e) {
    /* 下面统一报 */
  }
  const fn = producerSrc
    ? new RegExp(`function\\s+${p.fn}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`).exec(producerSrc)
    : null;

  if (!fn) {
    problems.push({
      file: p.file,
      line: 1,
      rule: `找不到 ${p.fn}() 的函数体（或读不到该文件）`,
      why: `契约 F 要在这里核对它喂的令牌：${THEME_SAMPLE_CONTRACT.why}`,
    });
  } else {
    const fnLine = lineOf(producerSrc, fn.index);
    for (const alias of aliases) {
      checked.fields++;
      const src = p.aliases[alias];
      if (!src) {
        problems.push({
          file: p.file,
          line: fnLine,
          rule: `${THEME_SAMPLE_CONTRACT.file} 用了 ${alias}，但 ${p.fn}() 没有对应的主题令牌`,
          why: `别名表要跟着 CSS 一起加，否则样本会静静退回 var(--bg)`,
        });
      } else if (!fn[1].includes(`${alias}:`)) {
        problems.push({
          file: p.file,
          line: fnLine,
          rule: `${p.fn}() 没有把 ${alias} 写进返回的行内样式`,
          why: `${THEME_SAMPLE_CONTRACT.file} 拿它当"${alias === '--t-bg' ? '盘心（底色）' : '外环（主色/次色）'}"用`,
        });
      } else if (!new RegExp(`\\[\\s*['"]${src}['"]\\s*\\]`).test(fn[1])) {
        problems.push({
          file: p.file,
          line: fnLine,
          rule: `${p.fn}() 里的 ${alias} 不是取自主题令牌 ${src}`,
          why: '样本要画的是"这套主题的"底色与主色，取错令牌会画出别的主题的颜色',
        });
      }
    }
  }
}

if (problems.length) {
  console.error(`CSS 令牌契约检查未通过（扫描 ${checked.rules} 条规则 / ${checked.fields} 个受检声明）\n`);
  for (const p of problems) {
    console.error(`  ✗ ${p.file}:${p.line}`);
    console.error(`      ${p.rule}`);
    console.error(`      为什么不行：${p.why}`);
  }
  console.error(`\n共 ${problems.length} 处问题。`);
  process.exit(1);
}

console.log(
  `CSS 令牌契约检查通过（${files.length} 个文件 / ${checked.rules} 条规则 / ${checked.fields} 个受检声明）`
);
