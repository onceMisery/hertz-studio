// SPDX-License-Identifier: MIT
// 浏览器验收脚本的令牌来源。
//
// 为什么要有这个文件：`GET /` 现在只在**出示凭据**时才把令牌写进页面，否则回的
// 就是那份「需要凭据」的自救页。于是验收脚本不能再像以前那样先 `fetch(base + '/')`
// 再正则抠 `window.__VMUSIC_TOKEN__`，也不能裸导航到 `/` —— 它会拿到 401 的壳子，
// `window.Stage` 之类一个都不存在，脚本只会以「界面没起来」失败，看不出真因。
//
// 令牌从哪来（按优先级）：
//   1. `VMUSIC_UI_TOKEN`：直接给。
//   2. `VMUSIC_DATA_DIR` 下的 `token` 文件：给服务的数据目录，隔离实例用它自己的。
// 都没有就抛错，并把这两条路写进信息里，省得下次再猜一遍。

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TOKEN_ENV = 'VMUSIC_UI_TOKEN';
const DATA_DIR_ENV = 'VMUSIC_DATA_DIR';

function uiToken() {
  const fromEnv = (process.env[TOKEN_ENV] || '').trim();
  if (fromEnv) return fromEnv;
  const dir = (process.env[DATA_DIR_ENV] || '').trim();
  if (dir) {
    const file = path.join(dir, 'token');
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  }
  throw new Error(
    `取不到服务令牌：设 ${TOKEN_ENV}=<token>，或 ${DATA_DIR_ENV}=<隔离实例的数据目录>。` +
      '（`GET /` 已收紧：无凭据时不再把令牌注入页面，所以脚本没法再从 HTML 里抠。）');
}

/// 带凭据的首页地址。导航用它；`fetch()` 也可以直接用它。
function uiUrl(base, params) {
  const url = new URL(base.endsWith('/') ? base : base + '/');
  url.searchParams.set('token', uiToken());
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
  return url.toString();
}

module.exports = { uiToken, uiUrl };
