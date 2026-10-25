# Reader 真实源验证 v1

日期：2026-10-24。目的：reader 领域开发完成后，用真实公网 RSS 源做一次端到端实机验证。

源清单取自 [awesome-rsshub-routes](https://jackyst0.github.io/awesome-rsshub-routes/)
（页面数据为 JS 渲染，实际清单来自其 `feeds.opml`，128 个订阅源）。从清单中按形态挑选
10 个本机可达源 + 3 个不可达/非法地址；全部为公开无密钥订阅源，抓取走服务自身
`public_net` 路径，不做任何账号或付费调用。

## 方法

`validate-real-feeds.js`：

1. 启动隔离服务（release `hertz-studio.exe`，`--data-dir` 临时目录、`VMUSIC_BACKEND=null`、
   `VMUSIC_SECRETS=memory`、`--port 0`，经 `vmusicd.json` 发现端口与 token）。
2. 对每个源依次走 preview → subscribe → entries 列表 →（有正文的条目）detail →
   图片代理 → TTL 刷新（force=false）→ 强制刷新（force=true）→ 已读标记 → 未读差值。
3. 断言：preview/订阅/列表/详情 HTTP 200；列表不携带全文、摘要 ≤280；正文无
   `<script>`/`<iframe>`/事件属性、`img src` 全部为登记键、`a href` 全部为绝对
   HTTP(S)；图片代理返回 `image/*` 且 ≤6 MiB；不可达源错误上抛且不落库；
   订阅汇总未读数精确减一。
4. 产品对瞬时网络故障不自动重试（按 spec 语义如实上抛）；测试侧重试一次仅用于
   区分产品缺陷与网络抖动。

## 结果（2026-10-24，binary sha256 `6639aa0d…`，总耗时 51 秒）

| 源 | 条目 | 正文缓存 | 图片 | 强制刷新 |
| --- | --- | --- | --- | --- |
| OpenAI News | 1318（全存档，页取 30） | 源仅给摘要 | — | synced=1318，20s 内完成 |
| arXiv cs.AI | 0（周末 `skipDays`，空源订阅成功） | — | — | — |
| Hacker News AI | 20 | 仅摘要 | — | **304**（ETag 生效） |
| A List Apart | 20 | 仅摘要 | — | **304** |
| Claude Code Releases (Atom) | 10 | 10 篇 cached（4.1 KiB） | — | **304** |
| 少数派 | 10 | 仅摘要 | — | synced=10（源无 ETag，全量合并） |
| IT之家 | 30 | 仅摘要 | — | **304** |
| FreeBuf | 20 | 20 篇 cached | 1 键 → 代理 200，123 KB/81 ms | synced=20 |
| DeepMind Blog | 30 | 仅摘要 | — | **304** |
| This Week in Rust (Atom) | 4 | 4 篇 cached（44 KiB） | — | **304** |
| V2EX（本机不可达） | — | — | — | `upstream_timeout`，不落库 |
| LinuxDo（本机不可达） | — | — | — | `upstream_timeout`，不落库 |
| example.com/feed（非 RSS） | — | — | — | `upstream_rejected` HTTP 404，不落库 |

订阅一致性：恰好 10 个可达源入库，错误路径零残留。

真实 UI 旅程：同一隔离服务 + 真实订阅数据，经 `?token=` 打开真实 Chrome 界面，
侧栏「阅读」进入真实文章（OpenAI News 当日更新的 "Rapidly scaling online storage
to serve over 1 billion ChatGPT users (Part II)"），列表/正文/未读徽标（1318 条
显示 99+）均正常渲染，正文容器 0 个 script 元素。截图（本机忽略目录）：
`output/reader-browser/real-service-{empty,list,article}.png`。

## 真实发现

1. **修复：查询布尔参数**。UI 最初发送 `unread=1`，服务端 serde 严格 bool 只接受
   `true/false`，未读/收藏筛选 400。已修（`reader.js` 改发 `unread=true`），stub
   fixture 同步更新——stub 旅程没有暴露它，真实服务一跑就现形。
2. **超时语义**。本机到 `simonwillison.net` 的链路不稳定（多次实测 504 connect 超时
   与 200 交替，最快的成功请求 0.42 s、最慢 17.2 s）。服务全部按 spec 行为：504 +
   `upstream_timeout` 如实上抛、不自动重试、不落半截数据、`last_error` 可查。该源未
   纳入必过集合，原因写明是网络环境而非产品行为。
3. **周末空源**。arXiv 的 RSS 声明 `skipDays` 周六/日，当天就是 0 条目；订阅与刷新
   语义在空源上仍成立。

## 边界

这是单机、单轮、真实网络的功能验证，不是性能验收（耗时只是观测值）、不是长时
稳定性或容量极限测量，也不代表发布候选验收；真实听感、其它 OS、弱网与发布矩阵
仍按原路线另行安排。二进制与脚本身份记录在 `results.json`。
