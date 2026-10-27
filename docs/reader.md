# RSS 图文阅读

独立「阅读」栏目：订阅博客、新闻等公开 RSS 2.0 / Atom 1.0 源，在应用内阅读源内图文正文。
与播客按用途分开管理（方案 B）：两个领域各自持有订阅、身份与数据表，同一地址可以在两处分别添加，
不自动同步订阅或取消操作；音频 enclosure 一律忽略，播客继续独占播放语义。

设计与边界依据 [RSS 图文阅读支持方案](../aegis/specs/2026-10-19-rss-document-support-design.md)
（批准记录与实施修订见其第 11 节）。本文只描述已实现的接口与行为。

## 使用方式

- 左栏粘贴公开 RSS/Atom 地址订阅；新源先经预览语义校验（同一请求模型）再落库。
- 左栏底部的「推荐」链接到公开 RSS 源列表（Awesome RSSHub Routes），在新窗口打开；它只用于发现地址，不写入订阅数据。
- 阅读页右上角的「网页全屏」收起订阅栏与文章列表、让正文占满窗口；同一按钮或 Esc 退出，窄屏的「返回文章列表」也会先退出全屏。
- 中栏为文章列表：全部 / 未读 / 收藏筛选，按发布时间倒序分页（默认 30、最多 100）。
- 正文详情成功显示后自动标记已读；收藏与已读都是显式赋值（不是 toggle），立即持久化。
- 「全部订阅」可回到跨源文章列表；当前文章保持高亮。布局按阅读区域的实际宽度调整，窄屏点开文章进入正文，点击「返回文章列表」回到原列表并恢复键盘焦点。
- 正文加载失败可原地重试；图片默认显示文字占位，点击加载后才请求，网络或图片解码失败可重试。
- 刷新订阅源后，已打开的文章会同步更新正文；内容未变时保留已加载图片。旧版本缓存的纯文本摘要可通过「刷新当前源」重新获取结构化正文。
- 取消订阅保留全部本地内容与阅读状态，源移入「已取消订阅」组并停止刷新；
  再次添加同一地址原位恢复。「删除数据」显式清除该源的文章、收藏与状态。
- 刷新策略：手动「刷新当前源」强制绕过缓存；进入某个订阅源时按 `force=false` 触发，
  15 分钟 TTL 内的直接复用已落库内容（同源请求合并）。

## 正文与图片边界

- 服务端用 ammonia 按允许列表清洗 HTML：脚本、事件属性、表单、iframe、内联样式、
  SVG/MathML 与非 HTTP(S) 协议全部剥离；客户端渲染前另用 DOMParser 白名单再兜一道。
- 图片地址在清洗时移出 `src`/`srcset`，替换为该条目登记的图片键（URL 的 SHA-256 截断 hex，
  同一条目内稳定）；浏览器不会直接请求源站。图片字节不落库，用户点「加载本文图片」后经
  `GET /v1/reader/entries/{id}/images/{key}` 代理：仅 HTTPS、`image/*` content-type、
  6 MiB 流式限额，与封面代理同手法，不做像素解码。
- RSS 正文优先使用 `content:encoded`，其次保留 `description` 的 HTML，经同一安全清洗和预算处理后显示段落、列表、链接与图片；列表摘要仍为纯文本。
- Atom 的 `summary type="html"/"xhtml"` 同样保留结构并经过正文清洗；纯文本摘要继续按文本显示。
- 标题与正文共用阅读列宽，全屏也限制行长；日报中列表前独占一段的短粗体栏目名增强为小标题样式。引用、代码、图片说明、嵌套列表和表格各自排版，长代码与宽表格在块内横向滚动。
- 标题平衡换行，表格保留英文单词完整性；新闻源中独立图片段落与相邻图注统一排版。真实文章的检查范围见 [渲染验收记录](../evals/reader/rendering-v1/README.md)。
- 源只给摘要时显示源内内容并提供「打开原文」；缓存成功不代表源提供了全文，不抓取网页全文。

## 预算（首期候选值，超限如实标注）

| 项目 | 值 | 达到上限后的行为 |
| --- | --- | --- |
| 单源 XML | 16 MiB | 按实际读取字节拒绝 |
| 单次条目扫描 | 2000 item/entry | 标明截断，不宣称已完整同步 |
| 单篇正文 | 清洗后 64 KiB | 标签边界截断并补齐闭合，`truncated` |
| 单源一次正文合计 | 8 MiB | 余项保留元数据与原文链接，`over_budget` |
| 图片引用 | 每篇 32 个 | 超限图片 `src` 置空且不发起请求 |
| 并发 | 全进程 2 个任务 | 额外任务立即 `reader_busy`，同源经 TTL 合并 |
| 单次刷新期限 | 网络/解析/落盘共 20 秒 | 超时返回错误并记录 `last_error`；并发槽保留到实际工作退出 |
| 本地存储 | 200 源 / 5 万条 / 256 MiB 逻辑字节 | 拒绝新增并提示清理；逻辑字节不代表 SQLite 物理体积 |

## API

HTTP 与 DBX RPC 共用同一请求模型与服务函数（薄壳门面，与播客一致）：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/v1/reader/preview` | 有界读取并返回源摘要与少量条目，不落库 |
| GET | `/v1/reader/subscriptions` | 订阅与保留的已取消订阅，含未读数与最近错误 |
| POST | `/v1/reader/subscriptions` | 订阅/原位恢复，新源受 200 源上限约束 |
| DELETE | `/v1/reader/subscriptions/{id}` | 取消订阅并保留内容 |
| DELETE | `/v1/reader/feeds/{id}` | 显式删除该源全部本地数据 |
| POST | `/v1/reader/feeds/{id}/refresh` | `{force}`，返回 `{synced, not_modified, fetched_at}` |
| GET | `/v1/reader/entries` | `feed_id/unread/starred/cursor/limit`，列表不带全文 |
| GET | `/v1/reader/entries/{id}` | 正文、图片引用与用户状态；响应超 256 KiB 缩减正文 |
| PUT | `/v1/reader/entries/{id}/state` | `{is_read, starred}` 显式赋值 |
| GET | `/v1/reader/entries/{id}/images/{key}` | 仅放行该文章登记过的键，`{data, content_type}` 信封 |

错误沿用统一信封，业务码：`reader_invalid_feed`、`reader_unsupported_encoding`、
`reader_feed_too_large`、`reader_busy`、`reader_storage_full`。

## 验证入口

- Rust：`cargo test -p hertz-studio --lib reader::`（解析、清洗、身份、迁移行为、容量与刷新路径）。
- 前端：`node scripts/check-frontend.js`（含资产与路由清单一致性）。
- 浏览器旅程：`node scripts/check-reader-browser.js`（真实 Chrome + 确定性 transport：
  未读徽标、正文阅读、客户端 XSS 加固、图片按需代理、已读/收藏持久化、筛选、
  游标分页、订阅/退订/删除确认与窄屏布局）。
- DBX 形态：`plugin/backend` 通用转发，无需登记；`scripts/check-plugin-sidecar.js` 的
  reader 断言为后续增量。

## 已知限制

- `xml:base` 仅在正文根元素级生效；嵌套 `xml:base` 不解析。
- `srcset` 中含逗号的 URL 属于 best-effort 重写的已知限制，可能整段丢弃。
- 弱身份（无 GUID 且无原文 URL）完全同键去重，源内容变动可能产生重复条目。
- 不做全文检索、OPML、后台轮询与原网页正文提取（后续另审）。
