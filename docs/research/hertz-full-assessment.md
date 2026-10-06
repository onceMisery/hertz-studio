# hertz-studio 全面评估报告（对照 folia-major）

> 日期：2026-10-05 · 审计基线：master `acc8707`（Scrobble 频控闸门之后）
> 方法：功能/UX 维度基于 10 项功能对照审计（对照库 D:\code\github\folia-major）；安全、性能、代码质量三个维度由三路独立源码审计产出，全部结论带文件:行号证据。
> 本文档为工作笔记，不提交入库。

## 总评

功能面已高度对齐 folia（10 项中 6 项已对齐、3 项小差距、1 项大差距），安全意识明显高于同类本地服务（SSRF 三重校验+单测、钥匙串存凭据、SQL 全参数化、textContent 渲染、上游错误脱敏）。真正的短板集中在三处：

1. **一处可证实可利用的路径穿越**（封面三端点）
2. **三条用户可感知的性能热点**（前端 50fps 渲染管线 / 扫描逐文件事务 / play_commit 锁内 await）
3. **app.js 单文件多职责**（6969 行 / 192 函数 / state 跨 8 文件 163 处直接赋值）带来的高碰撞区

反差值得注意：防御性基建（契约脚本 512/584 项、SSRF 校验、钥匙串、Rust 测试 233 项）相当扎实，但**热路径纪律**（锁内 await、50fps 全量 DOM、逐文件事务）和**最大文件的职责边界**是相对薄弱面。

---

## 一、安全性

| # | 问题 | 位置 | 等级 | 方向 |
|---|------|------|------|------|
| S1 | **封面 id 路径穿越**：axum 0.8 对 Path 参数做 percent-decode，且解码发生在路由分段匹配**之后**——`..%2f` 能以单段身份通过 `{id}` 匹配再解码为 `../`，随后直接 `join`，可穿越**读**（get_cover）、**写**（replace_cover）、**删**（batch_delete）任意 `.jpg/.png/.webp/.gif` 文件（已复核三端点源码，均无 id 格式校验） | routes.rs:913-922、:799-840（写还先 remove 旧扩展名）、:886-895 | **中高（可证实可利用）** | 一个 helper：join 前校验 id 为 UUID 格式（或拒绝含 `/`、`\`、`..` 的解码值），三端点共用 |
| S2 | 非 loopback bind 时 `GET /` **无鉴权**返回内嵌长效 token 的 HTML，全 API 沦陷；`--bind`/`VMUSIC_BIND`/config.toml 可配 0.0.0.0；ws.rs:5-8 注释声称启动断言 loopback，实际无此断言 | main.rs:414-427、config.rs:72-75 | 中（条件触发） | 非环回 bind 时启动显式告警 + 不在 HTML/discovery 暴露 token（改首跳一次性票据换取会话） |
| S3 | 查询串长效 token 面：GET/m3u 下载/WS/overlay 都走 `?token=`，进浏览器历史、OBS 配置、代理日志 | routes.rs:258-263、app.js:6422-6423 | 低 | 短时效 ticket 交换；或至少 m3u 改 Bearer 头 |
| S4 | sqlx 错误 `e.to_string()` 直接回显客户端（SQL 文本/内部路径泄漏给持 token 者） | routes.rs:852、:2374 等 | 低 | 统一 map 成 request_id + 服务端日志 |
| S5 | token 比较用普通 `==` 非常数时间 | routes.rs:266 | 低（本地服务影响极小） | `subtle::ConstantTimeEq` 或忽略 |

**安全面做得好的（不需动）**：token 生成强度足够（双 UUIDv4 ≈244bit 熵，Unix 下文件 0600）；无 CORS 层（同源策略默认生效，写操作需 Bearer 头，无 CSRF 面）；cred 走 OS 钥匙串且启动迁移删明文、GET /v1/settings 过滤凭据键；SQL 全参数化（动态拼接仅限枚举/白名单片段）；前端统一「静态骨架 + textContent 填值」未发现上游 title/artist 未转义进 innerHTML 的点；WS 升级时校验 token；上游错误 redact_qs 脱敏。

---

## 二、性能

| # | 问题 | 位置 | 影响 | 方向 |
|---|------|------|------|------|
| P1 | **前端状态帧渲染管线**：实况 ~50fps（actor.rs TICK=20ms 每 tick 无条件发 Snapshot；频谱另 30fps），`updateRowActiveState` 每帧遍历全部已渲染行做 2×classList.toggle——一页 200 行 = **2 万次 DOM 操作/秒**；`document.title` 每帧赋值；进度条每帧写 5 个属性（range/aria/textContent/style.width）；频谱每帧新建 canvas 渐变对象 | app.js:1547-1553、:1481、:4218-4233、:2056-2068；actor.rs:55-56、:352 | **高（常驻 CPU）** | active 状态改增量 diff（记录上一 active id 只动两行）；title/进度帧节流到 ~10fps；频谱渐变缓存。一处改动消 90% 常驻消耗 |
| P2 | **扫描逐文件两条独立事务**：每文件 `upsert_track`+`set_track_rg`（两条独立隐式事务），每封面再读一次 `is_cover_edited`；万首 ≈ 2 万次独立提交（WAL 但 synchronous 默认 FULL） | scan.rs:298、:314-317 | **高（首扫耗时）** | 每 200-500 首一个显式事务（sqlx begin/commit）；`is_cover_edited` 批量化。近数量级提速 |
| P3 | **play_commit 锁纪律失守**：`play_local` Remote 分支在提交锁内做 `auth_for_url`（DB 读）+ `HttpRangeStream::open`（网络建连）+ `load_source` await——违反 play_online 自己注释声明的「网络 await 都在锁外」纪律；`try_commit_cached` 锁跨 `audio.load`+`play`；`radio_status`（前端 5s 轮询）串行拿 play_commit+radio+queue+online_meta+cursor 五把锁并遍历整队拼 JSON（FM 关闭时 tracks 白收集后丢弃） | state.rs:833-870、:1381-1405；radio.rs:25-44 | **高（WebDAV 慢源加载期间切歌/换队被串行卡住）** | 照 play_online 既有模式把 await 移出锁；radio_status 退化为无锁快照读 |
| P4 | 搜索 `LIKE '%q%'` 前导通配 + `COALESCE(NULLIF(TRIM(...))) COLLATE NOCASE` 表达式排序，idx_tracks_title/artist/album 全失效，每次分页/count/facets 全表扫 + filesort + LEFT JOIN | vmusic-store/lib.rs:209-215、:357、:389 | 中（万级曲库滚动变卡，几千首尚可） | 生成列+索引，或 FTS5 虚表 |
| P5 | 在线缓存无内存索引：`find_cached_by_key` 是整目录 read_dir 扫描，内联在播放热路径（命中判定）+预取+`enforce_limit`——每次切歌最多 3 次全目录扫描/stat/排序 | online/cache.rs:62-83、:118-163；state.rs:980、:1663 | 中（缓存文件数百个时切歌延迟可见） | 启动建一次内存索引，写缓存时增量维护 |
| P6 | 51 个 `<script src>` 全同步、无 defer/async（index.html 全文唯一 "async" 命中是 `<img decoding="async">`，非 script），app.js 排最后；资源经 include_str! 直出且 `Cache-Control: no-cache`——每次刷新重拉重解析 3.19MB（no-cache 是有意为之：内嵌资源无 ETag/Last-Modified，启发式缓存曾把旧 JS 端出来致 bug 不更新，见 main.rs:434-436 注释；修法须配套版本指纹而非单纯去掉 no-cache） | index.html:51-1752；main.rs:437-447 | 中 | script 加 defer；资源加内容指纹 URL + `Cache-Control: immutable`（与现有 no-cache 注释语义兼容） |
| P7 | `online_meta` 普通在线听歌只增不减（仅 FM 超 80 首 trim 和接力迁移会删）、`stage_beats` 只 insert 无淘汰——长会话线性增长 | state.rs online_meta / stage_beats.rs:114、:140、:307、:338 | 低（条目小） | LRU 上限或会话级容量（仿 relay_tried 上限 64 自清的既有模式） |

**性能面干净的（不需动）**：WS 泵转发无锁、observe_listen 仅短命锁；广播容量 128 + Lagged 跳帧不断连；聚合搜索每源 spawn+6s 超时、并发度=音源数（≤8）天然有界；relay_tried/qr Registry/ScrobbleGate/前端 lyricReCache 均已有界；诊断日志单文件 2MB 上限、超限裁掉最旧一半（diag.rs:28-31），无磁盘增长风险；localStorage 只存 UI 偏好、队列从服务端恢复。

---

## 三、代码质量与可维护性

| # | 问题 | 证据 | 方向 |
|---|------|------|------|
| M1 | **app.js 单文件多职责**：6969 行（非空 6501）、192 个顶层函数、76 个分节注释，横跨封面缓存/WS/队列/歌词/歌单/右键菜单/扫描/诊断/主题/睡眠定时/悬浮胶囊；`state.X` 直接赋值 **163 处、分布 8 个文件**（app 56 / backgrounds 35 / online-playlist-view 27 / theme-studio 24 / online-playlists 16）——state 是 script 顶层 const，靠全局词法环境被 51 个 script 共享，无封装边界 | app.js:292-333 | P1 但长线：state 收敛为模块私有 + 显式 setter；新功能一律独立 IIFE 文件（stage-shelf.js / video-export.js 已是好范式）；initStage(1906)/initStageControl(3994) 装配逻辑移出入口文件 |
| M2 | **catch 空吞 67%**：全 ui 48 处 `catch(() => {})` / 空 catch，失败静默 | app.js:57 处 catch 中 38 空 | 至少统一走 toast/errText，逐处判断「真该吞」还是「懒得写」 |
| M3 | **请求路径 unwrap + panic=abort**：release 下单请求 panic 崩全进程。分布：全库 647 处/40 文件，大头在测试（state.rs 23 处全在 `#[cfg(test)]`）；生产风险区是 scan.rs 62 处（后台任务 panic 即死）、cpal_backend.rs 32 处、请求路径 online/ 23 处（多为 `Url::parse(常量).unwrap()`，实际低风险）；main.rs 0 处 | scan.rs、cpal_backend.rs、online/*.rs | 常量 parse 挪 OnceLock；scan 后台任务包 catch_unwind 或改返回值传播 |
| M4 | **样板重复**：online 三源（netease/qq/kugou）各自实现同构 7 函数面（search/playlists/playlist_detail/playlist_create/delete/add/remove）= 21 个平行函数 + 各自 http/cookie/签名样板——mod.rs 注释自己承诺「一个源文件+一行注册」，playlist CRUD 未兑现；皮肤侧 skin.liunian.js(1068 行) 与 skin.qingfeng.js(2229 行) 有 223 行完全相同（liunian 的 26%） | online/netease.rs、qq.rs、kugou.rs；skins/*.js | trait/模板收敛（保持 dispatch 表驱动）；皮肤公共部分抽 shared 模块（注意 check-skins 强制两套皮肤选择器集合正交的契约） |
| M5 | **API 契约只活在 README 手写表格**（已漂移：README 写 80 条 `.route()`，实测 85 条），无 OpenAPI/Swagger；前端行为测试基本缺失——192 个函数仅 4 个被 check 脚本触及，且 check-player-races.js 靠**字符串切片**从源码抠出被测函数（注释自认切片边界易碎） | routes.rs、scripts/check-player-races.js | 路由清单从代码生成（复用 check-library-api.py 思路）；行为测试至少覆盖 applySnapshot / applyQueue / 乐观 UI 三条命脉 |
| M6 | 依赖卫生：tower-http 0.6 在 workspace.dependencies 声明但全仓库 0 处使用（死声明）；symphonia `features=["all"]` 偏重；keyring 唯一绕过 workspace 直写版本；无 `rust-version` 字段兜底 README 声称的 1.85+ | Cargo.toml（两级） | 清死声明、按实际格式裁剪 symphonia features、补 rust-version |

**可维护性面干净的**：TODO/FIXME 存量为零（全库仅 vendor 误匹配）；皮肤 CSS 间重复度低（契约强制正交）；错误处理 Rust 侧整体克制；docs/ 的 10-intent/20-checkpoint/90-evidence 过程笔记模式值得保留。

---

## 四、功能完整性（对照 folia，10 项）

已对齐 6 项：会话恢复（且比 folia 多恢复播放位置）、队列存为歌单（c76fe44 在线按音源拆分）、睡眠定时器、缓存限额（比 folia 多钉住/分项/手动清理）、视频导出、Scrobble（acc8707 频控刚补齐）。剩余：

| # | 差距 | 等级 | 方向 |
|---|------|------|------|
| F1 | **命令面板**：hertz 有 Ctrl+K、四档模糊打分、recent 6 置顶、约 45 条命令；folia 另有 pinned 固定命令（pinnedCommandPreferences）、自定义快捷键（customShortcut）、十余个内联交互 surface（音量滑杆/睡眠定时/队列浏览/歌词分段编辑/FM 模式/网格过滤等 surfaces/）、语法联想 | **大** | 先做「recent → 可固定」+ 音量、睡眠两个内联 surface（面板体验溢价全在 surfaces），其余按需 |
| F2 | 在线补全：核心匹配语义（加权 45/25/30、时长乘数、≥60 采纳）已对齐；缺单曲 noAutoMatch 退出开关、AbortSignal 批量取消、逐曲状态回报（matched/failed/skipped）、手动候选挑选 modal、protectOrigins 不覆盖手工编辑——**错封面/错歌词静默写库后不可回退** | 小（但数据风险） | 候选挑选 modal + noAutoMatch 标记 + AbortController |
| F3 | 歌词输出：四风格+逐字扫色+译文已对齐（43c25e5）；folia 另有 OBS 自定义 CSS 注入（obsCustomCss + 复制按钮），hertz 只有 query 参数 | 小 | 设置页加 CSS 文本域，overlay 页 `<style>` 注入 |
| F4 | 响度三档：off/track/album 已对齐；但 state.rs:433-435 在线曲显式跳过，folia 用 provider 声明增益 + 缓存 ReplayGain（resourceCache get/saveCachedSongReplayGain） | 小 | online_meta 里带响度字段，换源接力时迁移 |
| F5 | **多语言**：hertz 前端硬编码 zh-CN（index.html `lang="zh-CN"`、无 i18n 基建），folia 有 i18n/locales（zh-CN / en / in 三语） | 小（对中文用户无感，发布面向再升） | 若需国际化：IIFE 体系内做极简字典表 + `data-i18n` 属性替换，不引框架 |

## 五、用户体验

- 命令面板 / 在线补全差距见 F1/F2（用户可感知的主要缺口）
- 扫描后 `library_changed` 全量重置曲库，滚动位置丢失（app.js:933）——改增量合并
- 曲目行 active 高亮全量遍历也直接造成「切歌瞬间 UI 迟滞感」（同 P1，修渲染管线一并解决）
- 皮肤系统历史坑（栅格/选择器契约/重编排）已有 check-skins 守护，模式成熟
- 无障碍：进度条有 aria 但整体键盘导航面未系统覆盖（folia 同样未做，可后置）

**UX/数据安全面已具备、复核确认不缺的**（避免未来误报为缺口）：
- **备份导入/导出已存在**：设置页「导入备份」覆盖歌单、收藏、设置与曲库目录（不含平台凭据），导入按名字合并、收藏去重可重复执行（index.html:930-941）
- **MediaSession 已完整接线**：metadata / playbackState / setPositionState / setActionHandler 全套（app.js:4096-4138），OS 媒体键可控播放
- 每曲歌词偏移、歌词导入/清除、WebDAV 目录导入等入口均在（index.html:1621-1632、:1553-1567）

---

## 优先级路线图

### P0 —— 数据/安全风险或大收益小改动（建议立即）

1. **S1 路径穿越**——一个校验 helper 修三端点，全库唯一可证实可利用项
2. **P2 扫描批量事务**——改动小、首扫近数量级提速
3. **F2 在线补全手动确认**——错数据写库不可回退，先堵数据风险再加功能

### P1 —— 用户可感知卡顿 + 结构性地基

4. **P3 play_commit 锁纪律**——照 play_online 既有模式重构，消除慢源串行
5. **P1 前端渲染管线**——active 增量 diff + 帧节流，消 90% 常驻 CPU
6. **M3 请求路径 panic 面**——panic=abort 下单请求可崩全进程
7. **F1 命令面板 pinned + 两个内联 surface**——面板体验的主要差距

### P2 —— 体验增强与长线健康

8. P4 搜索索引 / P5 缓存内存索引 / P6 defer+缓存指纹（万级曲库与弱机场景再升 P1）
9. M1 app.js 渐进拆分 / M4 online 样板收敛（新改动前顺手做，不专项立项）
10. M5 API 契约机器化 / M2 catch 清理 / M6 依赖卫生 / S2-S4 安全低项
11. F3 OBS 自定义 CSS / F4 在线曲响度 / F5 多语言 / 无障碍

## 附：审计方法与信息源

- 功能/UX：10 项功能逐项审计（Explore agent，对照 folia-major 源码定位到文件:行号）
- 安全：8 面审计（认证/绑定/路径/上游/凭据/注入/WS/杂项），含 axum 0.8.9 Path 参数 percent-decode 行为的源码确认
- 性能：锁与热路径/DB 访问/前端启动/渲染热点/缓存/并发/内存 7 项，帧率为实测代码推算（非记忆值——早前记忆中的「8fps 状态帧」有误，实况 ~50fps）
- 代码质量：8 项（巨型文件统计/测试/错误处理/重复/边界/TODO/文档/依赖），统计为客观计数

## 附 2：复核记录（2026-10-05，文档落盘后的二次核实）

对报告的关键断言逐条回到源码复核，结果：

**核实成立（无需改动）**：
- S1 路径穿越三端点（get_cover/replace_cover/batch_delete 的 `dir.join(format!("{id}.{ext}"))` 均无校验）
- S2 无鉴权 index 内嵌 token（main.rs:417-426 无中间件）+ ws.rs:8 注释声称「asserted at startup」但全库无 `is_loopback` 断言
- P1 updateRowActiveState 全行遍历（app.js:1547-1553）、TICK=20ms（actor.rs:56）
- P2 逐文件两事务 + 每封面 is_cover_edited（scan.rs:297-317）
- P3 play_commit 锁内 DB 读 + 网络建连 + load_source（state.rs:833-871）
- P4 排序表达式（vmusic-store/lib.rs:209-215）、P5 find_cached_by_key read_dir（cache.rs:62-83）
- S5 token `==` 比较（routes.rs:266）
- M5 README「80 条 .route()」漂移（实测 85 条）
- M1 app.js 6969 行 / 非空 6501 行

**复核中修正的两处**：
- P6：script 数 45 → **51**（且 index.html 唯一 "async" 命中是 `<img decoding="async">`，确无任何 script defer/async）；`no-cache` 是有意设计（main.rs:434-436 注释记录了启发式缓存事故），改进方向已改为「内容指纹 + immutable」而非单纯去 no-cache
- P3：radio_status 锁数四 → **五**（play_commit/radio/queue/online_meta/cursor）

**复核中补入的遗漏**：
- F5 多语言（hertz 硬编码 zh-CN，folia 三语 locale）
- 「确认不缺」清单（第五节末）：备份导入/导出（index.html:930-941）、MediaSession 全套含 setActionHandler（app.js:4096-4138）、每曲歌词偏移/WebDAV 导入入口、诊断日志 2MB 裁半轮转（diag.rs:28-31）

**复核中排除的疑似项**（查证后不成立，记录避免重查）：设置导入导出（已有备份功能覆盖）、OS 媒体键（MediaSession action handler 已接）、日志无界增长（有裁半轮转）。
