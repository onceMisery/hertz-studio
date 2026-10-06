// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// REST 路由清单生成器 / 契约检查（零依赖）。
//
// 起因：README 的 API 一节原来手写「共 103 个方法+路径（routes.rs 的 80 条 .route()）」
// ——那次统计之后路由改过几轮，数字早就不是 80 了。这类「手写的机器可数事实」必然漂移，
// 所以清单改成从这里生成，并在 --check 模式下与源码比对。
//
// 解析对象是 `crates/hertz-studio/src/routes.rs`（/v1/* 业务路由）与
// `crates/hertz-studio/src/main.rs`（/ws + 内嵌静态资源）。做法：
//   1. 去掉行注释（逐字符扫描，字符串里的 `//` 不算）；
//   2. 扫 `.route(`，按括号配平取出整段调用（多行写法很常见）；
//   3. 从调用里取第一个字符串字面量当路径，扫 get/post/put/delete/patch 得方法集合。
//
// 用法：
//   node scripts/api-routes.js          # 把生成块写回 README（锚点之间）
//   node scripts/api-routes.js --check  # 只校验，不一致则退出码 1

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ROUTES_RS = path.join(ROOT, 'crates', 'hertz-studio', 'src', 'routes.rs');
const MAIN_RS = path.join(ROOT, 'crates', 'hertz-studio', 'src', 'main.rs');
const README = path.join(ROOT, 'README.md');

const BEGIN = '<!-- api-routes:begin -->';
const END = '<!-- api-routes:end -->';

const METHODS = ['get', 'post', 'put', 'delete', 'patch'];
/** 静态资源路由（`asset(...)`）在清单里按数量汇总，不逐条列——它们是实现细节。 */
const ASSET_SENTINEL = 'asset(';

/// 逐字符去行注释：字符串字面量里的 `//` 不是注释。
function stripComments(src) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += src[++i] || ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += c;
  }
  return out;
}

/// 取 `.route(` 调用整段文本（括号配平）。
function readCall(src, openParen) {
  let depth = 0;
  let inStr = false;
  for (let i = openParen; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return src.slice(openParen, i + 1);
    }
  }
  return null;
}

/// 解析一个文件，返回 `{ path, methods[] }` 列表。
function parseRoutes(file) {
  const raw = fs.readFileSync(file, 'utf8');
  // 测试模块里也可能搭 Router（不该计入对外清单）。
  const cut = raw.indexOf('#[cfg(test)]');
  const src = stripComments(cut >= 0 ? raw.slice(0, cut) : raw);
  const found = [];
  const re = /\.route\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const call = readCall(src, src.indexOf('(', m.index));
    if (!call) continue;
    const lit = call.match(/"([^"]*)"/);
    if (!lit) continue;
    const methods = METHODS.filter((verb) => new RegExp(`\\b${verb}\\s*\\(`).test(call));
    found.push({
      path: lit[1],
      methods: methods.map((v) => v.toUpperCase()),
      asset: call.includes(ASSET_SENTINEL),
    });
  }
  return found;
}

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

function render(routesRs, mainRs) {
  const api = routesRs.filter((r) => !r.asset);
  const assets = mainRs.filter((r) => r.asset);
  const other = mainRs.filter((r) => !r.asset);

  const pairs = [];
  for (const r of api) {
    for (const method of r.methods) pairs.push({ method, path: r.path });
  }
  pairs.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method);
  });

  const lines = [];
  lines.push(BEGIN);
  lines.push('<!-- 由 `node scripts/api-routes.js` 生成，勿手改；`--check` 会校验是否与源码一致。 -->');
  lines.push('');
  lines.push(
    `REST 路由表共 ${pairs.length} 个「方法 + 路径」`
    + `（\`crates/hertz-studio/src/routes.rs\` 的 ${api.length} 条 \`.route()\`），`
    + `另有 \`main.rs\` 挂的 ${other.length} 条路由与 ${assets.length} 条内嵌静态资源路由。`,
  );
  lines.push('');
  lines.push('| 方法 | 路径 |');
  lines.push('| --- | --- |');
  for (const p of pairs) lines.push(`| ${p.method} | \`${p.path}\` |`);
  if (other.length) {
    lines.push('');
    lines.push('`main.rs` 上另有：' + other
      .map((r) => r.methods.map((m) => `${m} \`${r.path}\``).join(' · '))
      .join('，') + '。');
  }
  // 表格紧贴 HTML 注释行时部分渲染器会把最后一行并进注释块，留个空行。
  lines.push('');
  lines.push(END);
  return { block: lines.join('\n'), pairs, api, assets, other };
}

function main() {
  const check = process.argv.includes('--check');
  const { block, pairs } = render(parseRoutes(ROUTES_RS), parseRoutes(MAIN_RS));
  const readme = fs.readFileSync(README, 'utf8');
  const begin = readme.indexOf(BEGIN);
  const end = readme.indexOf(END);
  if (begin < 0 || end < 0 || end < begin) {
    console.error(`README 里缺少生成锚点（${BEGIN} / ${END}）`);
    process.exit(2);
  }
  const current = readme.slice(begin, end + END.length);
  if (current === block) {
    console.log(`REST 路由清单与源码一致（${pairs.length} 个「方法 + 路径」）`);
    return;
  }
  if (check) {
    const cur = current.split('\n');
    const next = block.split('\n');
    const at = cur.findIndex((line, i) => line !== next[i]);
    console.error('REST 路由清单与源码不一致（README 里是生成物，请跑 `node scripts/api-routes.js`）');
    console.error(`  首个差异在第 ${at + 1} 行：`);
    console.error(`    README: ${cur[at]}`);
    console.error(`    源码  : ${next[at]}`);
    process.exit(1);
  }
  fs.writeFileSync(README, readme.slice(0, begin) + block + readme.slice(end + END.length));
  console.log(`已更新 README 的 REST 路由清单（${pairs.length} 个「方法 + 路径」）`);
}

main();
