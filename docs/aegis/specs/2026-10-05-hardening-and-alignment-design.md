# hertz-studio 加固与对齐改进计划（基于全面评估）

状态：已实施；剩余缺口收口跟踪见 `.trae/specs/close-hardening-gaps/`。问题证据与复核记录见 `docs/research/hertz-full-assessment.md`（评估基线 master `acc8707`）。

## 目标与证据

系统性消除全面评估识别出的短板，按风险与收益分三批实施：

1. **P0 堵风险**：全库唯一可证实可利用的安全漏洞（封面路径穿越）、首扫数量级提速、在线补全的候选可见性与手动确认（采纳过程用户不可见、不可干预）。
2. **P1 除卡顿与结构性隐患**：播放提交锁纪律、前端渲染管线常驻 CPU、请求路径 panic 面、命令面板体验差距。
3. **P2 长线健康**：索引与缓存、文件拆分与样板收敛、契约机器化、小功能差距。

当前实现证据（全部经二次复核，见评估报告附 2）：

- 封面三端点 `dir.join(format!("{id}.{ext}"))` 无 id 校验（routes.rs:913-922 / :799-840 / :886-895），axum 0.8 Path 参数 percent-decode 发生在分段匹配后，`..%2f` 可穿越读/写/删。
- 扫描逐文件两条独立隐式事务 + 每封面一次 `is_cover_edited` 查询（scan.rs:297-317），万首 ≈ 2 万次独立提交。
- 在线补全后端在请求内自动搜索+采纳+补缺（complete.rs），候选对前端不可见，无手动挑选、无单曲跳过、批量不可取消。现有采纳纪律本身是保守的（只补缺、不覆盖，标题/歌手永不动），但用户对「采纳了哪条」没有可见性与干预手段。
- `play_local` Remote 分支在 play_commit 锁内做 DB 读 + 网络建连 + `load_source` await（state.rs:833-871）；`radio_status` 每 5s 轮询串行拿五把锁（radio.rs:25-44）。
- 状态帧实况 ~50fps（actor.rs TICK=20ms 无条件发 Snapshot），`updateRowActiveState` 每帧遍历全部已渲染行（app.js:1547-1553），一页 200 行 = 2 万次 DOM 操作/秒。
- release `panic="abort"` 下请求路径 unwrap 单请求可崩全进程（scan.rs 62 处、cpal_backend.rs 32 处）。
- 命令面板为纯静态命令列表（palette.js，约 45 条命令 + recent 6），folia 另有 pinned、自定义快捷键、十余个内联 surface。

参考依据：

- folia-major `playbackReportGate.ts` / `pinnedCommandPreferences` / `surfaces/` / `obsCustomCss.ts` / `i18n/locales/`：P1/P2 批次的功能对齐目标。
- folia-major `onlineMetadataSearchService` + `localSongMetadataMatchService`：在线补全手动确认的交互参照。
- 项目自身既有好范式：play_online 的锁外网络纪律、relay_tried 上限自清、stage-shelf.js/video-export.js 独立 IIFE、ScrobbleGate 频控。

## 方案比较

1. **逐项独立立项（每项一份 spec）**：粒度细但开销大，且多数项改动面小，评估报告已含足够细节。
2. **单份分批路线图 spec（推荐）**：一份 spec 覆盖三批、每项含目标行为与验收，批次间独立可交付；单项实施时如发现复杂度超预期再拆子 spec。
3. **只做 P0 其余搁置**：最快但 P1 的用户可感知卡顿与 panic 风险持续存在。

## 推荐设计

### 批次 P0：堵风险（建议立即，互相独立可并行）

#### P0-1 封面 id 路径穿越修复（S1）

- 新增私有 helper（routes.rs 或独立小模块）：`fn safe_cover_id(id: &str) -> Option<&str>`——拒绝含 `/`、`\`、`..`（含解码后）与非 UUID 格式的值；本地曲目 id 恒为 UUID，在线曲不走这三个端点。
- get_cover / replace_cover / batch_delete_tracks 三处 join 前统一过 helper，非法 id 返回 400（读端点可 404，与现状「无封面返回 204」语义区分开）。
- 不改路由形态、不加中间件——这是一处数据校验，不是一层防御。
- 单测：`..%2f`、`..%5c`、纯 `..`、含空格、合法 UUID 五组用例钉死。

#### P0-2 扫描批量事务（P2）

现状约束：`upsert_track` / `set_track_rg`（vmusic-store/src/lib.rs:103、:431）签名绑死 `&SqlitePool`，调用方 begin 的事务不会被它们加入，sqlx 也不支持这种隐式嵌套——直接把现有函数放进 begin 块落不了地。

选定方案（不扩散改动面、SQL 仍集中在 store 层）：

- vmusic-store 新增两个批量函数，显式接受事务连接：
  - `upsert_tracks_batch(tx: &mut SqliteConnection, tracks: &[Track])`：复用现有 upsert SQL 文本（含 ON CONFLICT(path)），循环 bind 后一次 commit；
  - `set_track_rg_batch(tx: &mut SqliteConnection, rows: &[(TrackId, RgTags)])`：同模式。
  现有 `&SqlitePool` 单条函数保留不动，其余调用方零影响。
- scan.rs 主循环按 `SCAN_TX_BATCH = 200` 分组：`pool.begin()` → 两个批量函数 → `tx.commit()`；进度计数在 commit 成功后统一累加。
- `is_cover_edited` 改批前预取：每批开始对批内 id 一次 `SELECT id FROM track_edits WHERE id IN (?...)` 取集合，循环内查内存。track id 复用已经是批量预取的（scan.rs:246 的 `existing` map，含 id/mtime/size），不新增逐文件查询。
- 取消语义不变：cancel 检查点保持在批次事务边界之间，取消后已提交批次保留（与现状「已处理文件保留」一致）。
- 验收：单测断言批大小边界（199/200/201 首）的事务数与落库行数；现有 scan 测试全过；万首级目录实测首扫时长对比记录进 evidence。

#### P0-3 在线补全可见性与手动确认（F2）

现有采纳纪律保持不变（complete.rs:10-13：只补缺、不覆盖；专辑写 track_edits 覆盖层、封面下载后置 cover_edited、歌词存 LRC 原文；标题/歌手永远不动；封面/歌词即便误采纳也有删除端点可还原）。本项解决的是「采纳过程对用户不可见、不可干预」，把自动写库改为候选先行。

API 形态（拆两个端点，消除「dry_run 又默认自动采纳」的矛盾）：

- `POST /v1/tracks/complete/suggest`：body 沿用 `{track_ids, source}`，只做搜索+打分，**不写任何数据**。每曲返回 top 3 候选（封面缩略图 URL、标题、歌手、时长差、分值）+ 与现曲的字段差异（缺专辑/缺封面/缺歌词三槽位各自的建议动作）+ 该曲状态（match / no_match）。打分与采纳阈值（标题命中、≥60）语义不变。
- `POST /v1/tracks/complete/apply`：body `{track_id, source, candidate_id, slots: ["album","cover","lyrics"]}`，按指定字段子集应用单条选择；`candidate_id` 可为 null（表示用户显式跳过）。现有 complete_one 的补缺逻辑整体迁移到这里复用。
- 两个端点必须同步在 RPC 层注册（rpc/mod.rs:248-254 现有 `/v1/tracks/complete` 对等面）。旧的合一端点**直接删除**（已定）：实现时发现前端只有两处调用点，保留会形成双写路径。

前端交互：

- 补全报告页先调 suggest 渲染逐曲候选行；「全部采纳建议」按钮批量调 apply（只填≥60 且命中的槽位）——自动行为由此搬到前端、用户点之前零写库。
- 单曲手动挑选候选 + 槽位勾选后 apply；单曲「不匹配」跳过。
- 「不匹配」决定持久化（noAutoMatch）：新增 migration 0011 建独立表 `track_no_auto_match`（不给高频覆盖层 `track_edits` 加稀疏列），重跑 suggest 时标记曲直接跳过、不覆盖该决定；用户之后接受任一候选则自动撤销标记。项目迁移是 sqlx 的 up-only 约定，**没有 down 脚本**（与既有 10 条 migration 一致）。protectOrigins 语义：track_edits 已有的手工编辑字段不被建议槽位覆盖，用户手动 apply 除外。
- 批量「取消」：AbortController 中断在途 suggest/apply，已完成的逐曲状态保留，无半写状态（apply 为单曲单请求，天然原子）。

验收：错匹配场景在写库前可见且可跳过；取消后无半写状态；noAutoMatch 重跑不被覆盖（且跨重启保持）；HTTP 与 RPC 两侧端点行为一致；migration 在既有库上增量应用成功；check-assets/check-skins 过。

### 批次 P1：除卡顿与结构隐患

#### P1-1 play_commit 锁纪律（P3）

- `play_local` Remote 分支照 play_online 既有模式重构：auth_for_url / HttpRangeStream::open / load_source 的 await 全部移到 commit 锁外，锁内只做 attempt_alive 复核 + 提交。
- `radio_status` 退化为无锁快照读：active/loading/error 用原子或一次性小锁快照；tracks 仅在 radio.active 且 initial_generation.is_none() 时才收集（现状是先全收集再丢弃）。
- 验收：现有 233 项测试全过 + 新增「慢 Remote 源加载期间 set_queue 不被阻塞」的时序测试；WebDAV 场景手动验证记录。

#### P1-2 前端渲染管线（P1）

- `updateRowActiveState` 改增量 diff：记录上一 active 行 id，仅切换新旧两行的 class。覆盖两个必须同验的场景：①行节点未渲染（滚动窗口/虚拟列表外）时跳过、重新渲染时按当前 active 落位；②队列视图与曲库视图的 active 态共用同一套 diff 键，不能只改曲库。
- `document.title` 与进度条写入节流到 ~10fps（rAF 内时间戳门控）；值未变化时跳过写。
- `drawSpectrum` 的渐变对象创建移出每帧路径（初始化一次复用）。
- 顺带修 `library_changed` 的全量重置（app.js:933：扫描完成 `loadTracks(true)` 整表重建、滚动位置与展开态丢失）：改为按 id 增量合并（新增/更新/移除三集合 diff，复用 renderQueue 已有的 diff 模式），保持当前视图与滚动位置；无曲目时的初始化路径不变。
- 验收：长播放会话（≥30 分钟）前端 CPU 占用对比记录；切歌时 UI 无迟滞；扫描完成后列表位置保留；频谱视觉无退化。

#### P1-3 请求路径 panic 面（M3）

- `Url::parse(常量).unwrap()` 模式（online/ 约 23 处）改 OnceLock 懒初始化或启动时校验一次。
- scan 后台任务入口包 `std::panic::catch_unwind`（AssertUnwindSafe），panic 记为扫描错误条目而不是死整个任务。
- cpal_backend 的 32 处逐处评估：能改返回值/日志的改，确属「不可能失败」的留注释说明理由。
- 验收：grep 复核请求路径 unwrap 数量下降并逐处留档；人为注入 panic 的 scan 测试不中断服务。

#### P1-4 命令面板 pinned + 两个内联 surface（F1）

- recent 列表每项加「钉住」操作（上下文按钮或快捷键），pinned 持久化 localStorage（键 `vmusic.palette.pinned`），置顶于 recent 之前。
- 新增两个内联 surface（面板主区停留、Esc 返回命令列表）：
  - 音量 surface：滑杆 + 静音切换，实时调 `/v1/player/volume`。
  - 睡眠定时 surface：预设档位 + 自定义分钟输入 + 剩余时间展示，复用现有 sleep timer API。
- 不做自定义快捷键、语法联想（folia 的其余 surface 视使用反馈再排）。
- 验收：pinned 重启保留；两个 surface 键盘可完整操作（Tab/Enter/Esc）；check-skins 契约过。

### 批次 P2：长线健康（按需排期，每项独立）

| 项 | 内容 | 要点 |
|---|------|------|
| P2-1 搜索索引（P4） | **已完成**：FTS5 + trigram 索引表 `track_search`（迁移 0012，触发器同步覆盖后的展示值）+ 「索引取候选 → 主键点查」两步查询 | 迁移脚本进 migrations；保留现有排序语义；EXPLAIN QUERY PLAN 验证走索引。实测（10k 曲库，count+ids 一轮）：`Song 00123` 12.9ms → 3.0ms（4.3×）、`Song 001` 12.1ms → 4.6ms（2.6×）；空查询与 1~2 字符查询走原语句不变（零回归）；写入 +7%。设计要点：三列必须按列 UNION 粗筛（同表三列 OR 会让优化器放弃 trigram 约束）；候选作为顶层约束才能驱动主键点查；候选数超 2000 回落整表扫；trigram 匹配是近似（含空格模式会给超集），必须再由原 LIKE 复核 |
| P2-2 缓存内存索引（P5） | **已完成**：`CacheIndex`（启动扫描一次 + 写时增量 + 命中时单文件复核）承载 find/stats/enforce_limit/clear | find/enforce_limit 均走内存索引；目录外力变更在命中复核时即刻自愈（比「下次启动」更早）。实测（3000 个缓存文件，debug）：find 11.9ms → 123µs（96×）、stats 94.4ms → 1.2ms（79×）、上限未超的空转回收 725µs（每次提交曲目都会跑）。落盘注册做成端到端测试（本地 HTTP 下载 → rename → 索引可见） |
| P2-3 资源加载（P6） | **已完成**：内容指纹 URL + immutable 长缓存，`<script>` 全部 `defer` | 指纹在服务端算（`assets_fingerprint()`，FNV-1a over `ASSET_FINGERPRINT_INPUTS` 全部内嵌 JS/CSS），`render_index` 经 `version_asset_urls()` 给 index.html 里每个相对 `.js`/`.css` 引用拼 `?v=<16 位十六进制>`；新增 `asset_cache` 中间件——只有「查询串 v 等于当前指纹 + 响应是 JS/CSS」才把 `no-cache` 升级成 `public, max-age=31536000, immutable`，裸路径与 `/v1` 响应不受影响（`asset()` 注释语义保留）。指纹表与资产路由的覆盖关系由 check-assets.js 交叉断言（新增 66 项）。实测（隔离实例 7931）：`/` 输出 `app.js?v=04f441d634ab1c28`；`/app.js?v=<fp>` → immutable、`/app.js` → no-cache、`/app.js?v=deadbeef…` → no-cache、`/style.css?v=<fp>` → immutable。浏览器实测 51 个 `<script>` 全为 `defer`，`__VMUSIC_TOKEN__`/`Stage`/`VMusicTransport` 均已定义、UI 正常引导，无 defer 相关报错。顺带修 `check-skins.js`/`check-stanza-starborn.js` 里写死 `<script src=` 的 4 处断言（改为 `src="..."` / `<script[^>]*src=`） | 指纹用启动时 hash；immutable 缓存替代 no-cache；与 main.rs 的 no-cache 注释语义兼容 |
| P2-4 内存上限（P7） | **已完成**：`BoundedMap`（插入顺序 FIFO，超限逐条丢「最久没被写入」的一条）承载 `online_meta` 与 `stage_beats`；`ONLINE_META_CAP`/`STAGE_BEATS_CAP`/`RELAY_TRIED_CAP` 三个上限常量 | 上限远高于正常使用规模（8192/8192/64），只兜长时间运行的线性增长；不用 relay_tried 的「满了就清空」是因为这两张表清空会一次性丢掉当前队列全部曲目的标题；被淘汰的曲目再次入队/起播会重新写入 |
| P2-5 app.js 渐进拆分（M1） | 新逻辑一律独立 IIFE；存量按职责分批迁出 | 不专项重写；state 收敛为模块私有 + 显式 setter 从最高碰撞区开始 |
| P2-6 online 样板收敛（M4） | **已完成（本轮）**：playlist CRUD trait/模板化（跨源公共 helper `online/playlist_common.rs`，三源迁移，行为不变、能力位/错误语义逐字未动）；皮肤公共段已抽 `plugin/ui/skins/skin-shared.js`（两皮肤迁移；check-assets 674/674、check-skins 相关分区全绿、双皮肤浏览器冒烟通过——证据 `output/skins-smoke.cjs`） | 保持 dispatch 表驱动与 check-skins 正交契约 |
| P2-7 API 契约机器化（M5） | **已完成**：新增 `scripts/api-routes.js`，从 `routes.rs` + `main.rs` 解析 `.route()` 链（去注释、括号配平、展开多方法），生成 README 锚点之间的完整 REST 清单；`--check` 与源码比对，不一致退出码 1。顺带纠正 README 手写数字（103/80 → 实测 110 个「方法+路径」/ 87 条 `.route()`）。补 `rust-version`：实测锁定依赖图里声明的最高值是 **1.88**（cookie_store/encoding_rs/home/icu_* 都写 1.88），README 原称 1.85+ 偏低，两处一并改成 1.88 | 复用 check-library-api.py 的「机器可数事实不手写」思路；README 表格改为生成物；改依赖后重新核对 rust-version |
| P2-8 catch 清理（M2） | **已完成**：48 处静默 swallow 逐处判断——「懒得写」的补反馈，「真该吞」的补理由注释 | 新增 `persistSettings(patch)`（app.js）：设置表写入失败的统一出口，`toast(errText('设置保存失败', err))`；替换 15 处用户动作触发的静默写（界面密度 / 减少动效 / 动效分面 / 导航可见性 / 舞台空闲收起 / 播放行为 / 启动自动播放 / 听歌打卡 / 自动接力 / 播放模式，含设置页与命令面板两处入口）；输出设备切换、命令面板切播放模式同样补了 toast。其余按「真该吞」定案并写明理由：启动路径（首帧快照、自动播放）、后台尽力而为（窗口尺寸/关窗/拖拽通知、媒体键动作、歌词重拉、封面与曲目详情拉取、二维码作废旧票、作品集同步、健康探测）、无法上报的浏览器 API（localStorage 隐私模式/配额、`setPointerCapture`、`AbortController.abort`）。实测（重建二进制后，隔离实例 7933，浏览器）：成功路径两次 `PUT /v1/settings` 均 200 且 `#toast` 无 `show`；停掉后端再切同一批开关，两次各自弹出 `设置保存失败：Failed to fetch`（`class="toast error show"`）。`check-stage-idle.js` 的沙箱补 `persistSettings` 桩 | 「真该吞」留注释理由，「懒得写」补 toast/errText |
| P2-9 依赖卫生（M6） | **已完成**：删 `tower-http` 死声明（全仓库 0 处使用；删的是我们自己那条直接声明，它仍作为 reqwest 的传递依赖在树里）；`symphonia` 从 `features=["all"]` 裁到 11 个按扩展名逐个对应的 feature（+ `default-features=false`，否则默认集会把 mkv 拉回来），丢掉 mkv/caf 两个容器；NOTICE 去掉已不在依赖图的 figment；README 的 Web 框架/搜索两行同步更正 | `cargo tree` 复核：mkv/caf 从图里消失，`cargo tree -i tower-http` 只剩 reqwest 一条反向依赖；新增 `vmusic-library` 契约测试把「扩展名表 ↔ feature 列表」钉在一起（改了 features 会红）。既有差距记录在案：扩展名表里的 opus/ape/wma 本来就没有解码器（symphonia 0.5 不支持）。测试全过 |
| P2-10 安全低项（S2-S4） | **已完成（含 `/` 收紧）** | ① S2 绑定告警已做（非回环 bind 在 stderr 与 tracing 各打一行，说明「长期 token + 同网段可读」并给出 `--bind 127.0.0.1` 的替代；顺带修掉打印 URL 恒为 127.0.0.1 的问题，改为按实际绑定接口，IPv6 加方括号）；② S4 错误回显收敛已做（`CoreError::Store(Database)` 不再回显 sqlx 原文，改通用说明 + request_id，明细连同 request_id 进日志）；③ S3 的「至少」部分早已满足（`require_token` 本就同时接受 `Authorization: Bearer` / `x-vmusic-token` / 仅 GET 的 `?token=`，m3u 下载可用 Bearer）；④ **本轮新增票据通道**：`ticket.rs`（内存票据表，TTL 与次数双上限 + 容量上限与淘汰，票号是 v4 UUID，毒化锁不 panic）+ `POST /v1/auth/ticket`（HTTP 与 RPC 复用同一份 `routes::issue_ticket`）；`require_token` 与 `/ws` 增加 `?ticket=`，沿用「查询串只认 GET」的既有纪律，长期 `?token=` 双接受。实测（隔离实例 7936，12 项）：无凭据签票 401；默认票 `ttl=120000ms/uses=1`，首次 GET 200、同票再 GET 401；`uses=3` 票 200,200,200 然后 401；**POST 带票 401**（票不得触发控制面）；`?token=` 与 `/ws?token=` 仍 200/Open；伪造票 401；`ttl_ms=99999999999&uses=999999` 被收拢为 `3600000ms/4096`；`/ws?ticket=` 握手 Open、同票重连失败 | **前端迁移已完成**（app.js 新增票据管理器）：开机 `await refreshCoverTicket()` 先签一张 `uses=4096 / ttl=3600s` 的多用途票供封面（`coverUrl()` 是同步契约，票必须先在手），按 80% 寿命记账、到期在后台续签且**续签期间继续用旧票**（服务端那张还没过期，比退回长期 token 安全）；每次 WS 连接单独签一张一次性票；m3u 下载同封面走 `urlCredential()`；视频导出的歌词轮询改为 Bearer 请求头（那里是 fetch，不必进查询串）。**WS 不回退长期 token**：签不出票（服务重启窗口）就退避重试，与断线重连同一条路。实测（隔离实例 7938，3 首本地曲 + 1 张上传封面）：HTTP 层 `cover?ticket=` 首次 200、同票第二次 401、`uses=3` 三次 200 后 401、无凭据 401、`?token=` 仍 200；浏览器层 `/v1/` 资源 URL 中含 `token=` 的 **0 条**、封面 src 是 `?ticket=…` 且 `naturalWidth=256`（真加载）、WS URL 为 `ws://…/ws?ticket=…` 且 `readyState=1`；**中途重启后端逼出重连竞态**：重连后 WS 用了一张**全新的票**，5 次签票中 2 次在断网窗口失败、**没有产生任何 token 回退**、两窗口内新构建无控制台报错。**`/` 收紧已完成**（本轮，用户选定按 S2 收紧）：`main.rs` 的 `index` 加凭据闸门 `credential_ok` —— Bearer / `x-vmusic-token` / 会话 cookie / `?ticket=`（走 `redeem`，不是存在性检查）/ 兼容期 `?token=`，任一**值相等**才渲染；不通过就回一页自包含的「需要凭据」自救页，**任何一条路径都不再把令牌写进这一页**。通过时顺带下发 `Set-Cookie: vmusic_session=…; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`（**只被 `/` 认**，接口层仍要 Bearer，所以 CSRF 面没有变化），并新增 `POST /v1/auth/session`（令牌走**请求体**，不进 URL 历史）作为「清过 cookie / 换了浏览器 / 手敲了裸地址」的自救通道；打印与 `--open` 的入口 URL 由长期 `?token=` 改成一次性 `?ticket=`（为此新增 `AppState::issue_entry_ticket` / `redeem_ticket` 两个公开出口，票据的 TTL/次数上限仍留在 lib 内，bin 不需要知道）。实测（隔离实例 18799，curl）：裸 `/` → 401 且响应体不含令牌（是自救页）；Bearer `/` → 200 且 `window.__VMUSIC_TOKEN__ = "<token>"` 命中；`?ticket=` 首跳 200 + `Set-Cookie`（属性齐全），**同票复用 401**；只带 cookie 再开 `/` → 200（刷新/书签可用），而带同一 cookie 打 `/v1/tracks` → 401（cookie 只换得到首页）；`POST /v1/auth/session` 错令牌 401、对令牌 204 + `Set-Cookie`；`?token=` 兼容路径仍 200。浏览器三步实测（真实标签页）：带票首跳正常引导（`Stage`/`Skins` 已定义、`#conn` = 「服务已连接」）→ 去掉查询串刷新仍正常（走 cookie）→ 换 origin（无 cookie）显示自救页且页面源码不含 `window.__VMUSIC_TOKEN__ = "`。单测钉住闸门四条信道的正/负例（`index_credential_gate_opens_only_for_a_matching_credential`）与 cookie 属性/回读成对（`session_cookie_carries_hardened_attributes_and_reads_back`）。**顺带付清的代价**：依赖「裸 `GET /` 拿令牌」的 harness 全部改为显式带凭据 —— 新增 `scripts/ui-token.js`（`VMUSIC_UI_TOKEN`，或 `VMUSIC_DATA_DIR` 下的 `token` 文件），接入 `check-player-browser.js` / `check-ios-skin-browser.js` / `check-stage-visual-browser.js` / `check-3d-browser.js` / `check-search-browser.js` / `check-radio-browser.js` / `check-creative-preview-visual.js` / `check-sheen-topbar-browser.js` / `check-daily-scroll-browser.js`；`scripts/smoke.sh` 与 `scripts/smoke.ps1` 补 Bearer，并把「裸 `/` 必须 401」「票据一次性（兑换 200 → 复用 401）」「令牌换 cookie 后 cookie 能开首页、错令牌 401」写进 CI 断言（同时修掉两处 `grep mmusic` 的过期断言 —— 自项目改名起它一直是空匹配，只是失败被前面的 `set -e` 掩盖成了「smoke 没红」）。`check-liunian-settings-nav-browser.js` 属另一条工作线，未动，它同样需要接 `ui-token.js`。**浮层那把只读钥匙已完成**：`main.rs` 新增 `load_or_create_overlay_key`（数据目录 `overlay-key`，0600，与 token 同一套 `load_or_create_secret`）→ `AppState.overlay_key` → `GET /v1/auth/overlay-key`（HTTP+RPC 共用 `routes::overlay_key_payload`，插件形态如实报错）；`require_token` 新增 `?key=` 通道，**只认 GET 且只认两条路径**（`routes::overlay_key_allows`：`/v1/overlay/lyric` 与 `/v1/tracks/*/cover`），`app.js` 开机取回钥匙缓存（复制/预览要同步拼 URL，等网络往返还会让 `window.open` 掉出用户手势被拦），`overlay.html` 优先用 `?key=` 且继续接受老 `?token=` 链接。实测（隔离实例 7939）：钥匙文件生成 64 位十六进制；`GET /v1/auth/overlay-key`（Bearer）200 且与文件一致；钥匙放行 `overlay/lyric` 200、`tracks/{uuid}/cover` 200；钥匙**不放行** `/v1/state`、`/v1/settings`、`/v1/tracks`、`/v1/tracks/{id}`、`/v1/tracks/{id}/lyrics`、`POST /v1/player/pause`、`POST /v1/auth/ticket`（全 401），错钥匙 401，`?token=` 仍 200；**重启后同一把钥匙仍有效**（200）且仍受限（state 401）；浏览器打开 `/overlay?key=…&style=karaoke` 正常渲染、约 2 次/秒轮询 `overlay/lyric?key=…` 状态去重集 `{200}`（42 次无一 401）、页面内无 `token=`、无控制台报错；应用侧「预览」按钮实际打开的是 `…/overlay?key=38e55a84…&style=full`（复制按钮本身因自动化窗口无焦点被剪贴板 API 拒绝，报的是 `Document is not focused`，非代码问题）。**discovery 文件的 `token` 字段有意保留**：README 已声明的宿主握手契约，且是本地文件而非 URL。 |
| P2-11 功能小差距（F3/F4/F5） | **无障碍 + 在线曲响度（F4）+ OBS 素材通道（F3）已完成；F5 按原约定未启动** | 无障碍：`dialogs.js` 新增 `focusScope(node)`（设 body 兄弟节点 `inert` + 关闭还焦）并挂到 `window.hertzDialog.focusScope`；自建模态 prompt/confirm/pick 与命令面板共用它。实测：命令面板打开时 `.app.inert=true`、连按 3 次 Tab 焦点始终不在 `.app` 内、Esc 后 `inert=false` 且还焦；用临时探针页把 dialogs.js 跑在自建模态下复测 — picker 打开 `inert=true`/焦点入框、Tab 两次都在 `.np-modal` 内、Esc 后焦点回到 `#open-pick`；prompt 同理回到 `#open-prompt`。**F3 已完成（按用户选定：照搬 folia 的资产通道，只承载素材）**：新增 `plugin/ui/obs-css.js`（零依赖 IIFE，`window.ObsCss`）——`encode(kind, file)` 用 canvas 把用户选的图压到长边上限（背景 1280 / 台标 512；背景走 JPEG q0.82 并显式先铺一层 `#09090b` 底，台标走 PNG 保住透明通道）、`buildSnippet({background, logo})` 拼出可直接粘进 OBS「浏览器源 → 自定义 CSS」的片段（`:root` 里两条 `--hz-obs-bg` / `--hz-obs-logo` 加一行 OBS 透明 body 复位，并附改台标方位的注释提示；无素材时回 null）、`readAssets()` 用 `getComputedStyle` 把三个自定义属性读回来（`parseDataUrl` 只认 `url("data:…")`，其余一律回 null）。设置页「歌词输出」新增「自定义素材」（选背景图 / 选台标，file input 走既有 hidden 约定）与「素材 CSS」（复制 / 清空）两行 + 状态行（报出各素材体积）；素材存 localStorage（`vmusic.obs.assets.v1`）而不是服务端设置表 —— 它只服务于「复制一次、粘进 OBS」，OBS 自己会存那段 CSS，几 MB 的 data URL 不该进 settings 行。浮层页同步引 `/obs-css.js`（在自身脚本之前）并在启动时套用：背景图铺 body（cover/居中），台标按四角之一摆一个 `.obs-logo`。**实测**（隔离实例 18800，真实 Chrome + Playwright，临时脚本 `output/verify-obs-assets.cjs`，**33/33 通过**）：应用页拿到模块；设置页四行齐备、初始提示「还没有素材。」；没选图点复制 → 不产出片段且给出「先选一张背景图或台标」；喂一张 2000×1000 的 PNG → 压成 `data:image/jpeg;base64,` 且状态行报「背景图 13 KB」（真图真 canvas）；再喂 900×300 PNG 台标 → 报「台标 95 KB」，两槽齐备；点复制（剪贴板打桩）拿到**用户真正会粘进 OBS 的那段文本**（111674 字符，含两条 data URL + OBS 复位行 + 方位提示，只触发一次）；清空 → 状态行与 localStorage 双双复位。浮层侧把这段文本**像 OBS 一样在页面脚本之前注入**：无注入时 `.obs-logo` 0 个、`body.style.backgroundImage` 空、`readAssets()` 两个 null；注入后 `body` 背景是 `url("data:image/jpeg;base64,…")` + `cover / 50% 50%`、`.obs-logo.top-right` 有真实尺寸（w=101 top=29 right=51）、点唱机视图照常渲染、无未捕获异常；把片段里 `--hz-obs-logo-pos` 手改成 `bottom-left` → 类名与实测位置都挪到左下角（bottom=29 left=51）。契约脚本 `scripts/check-obs-css.js`（**53/53**，进 CI）：变量名两端一致、片段构成与空态、回读正负例（含手改坏的方位回落默认）、编码路径（缩放上限/JPEG 铺底/PNG 不铺底/object URL 回收/四条拒绝路径）、以及 index.html、overlay.html、main.rs（含内容指纹表）三处接线与四个方位类名。截图证据：`output/obs-assets/{app-settings,overlay-with-assets,overlay-pos-bottom-left,overlay-no-assets}.png`。**已知边界**：「OBS 真的会把 Custom CSS 注进页面的 `:root`」这一步由 folia 的既有实现背书，本机没有 OBS，无法实测；动图会被压成静帧（片段提示里写明了）。**F4 已完成**：真机探针证实网易云 `/api/song/enhance/player/url` 的 `data[0]` 带 `gain`/`peak`（另有 closedGain/closedPeak）→ `StreamInfo` 增 `rg_gain_db`/`rg_peak`（只 netease 解析；其余音源实测无对应字段，一律 None，不猜测）→ 取流时写进 `OnlineMetaSnap`（缓存命中那次不会再取流，值只能留在这儿）→ 三条提交路径（缓存命中 / 渐进式 / 整首下载）统一推 `apply_online_loudness`，与本地曲共用 `anti_clip_gain`；`current_loudness` 对 `online:` 不再直接返回 None。实测（隔离实例 7937，诊断日志）：fresh 播 → `play.commit via=progressive` 之前有 `loudness.apply mode=track from=online gain_db=0`；重入队后缓存命中 → 同样有该行再 `via=cached`（该曲平台 gain 恰为 0.0，与探针一致；防削波的数值边界由单测钉住）。顺带修两个拦路的既有缺陷：① `PUT /v1/player/dsp`（与 RPC 对等面）只写设置表与 actor、**从不更新内存里的 `state.dsp`**，而播放落地读的正是它 —— 表现为「改完响度档位只有当前这首生效，下一首又按启动时的旧档位重算」；② 同一首曲重入队会用空标签覆盖已取到的响度，新增 `remember_online_meta`（保留旧 RG）并让 HTTP/RPC 两个入队点改用它。**已知局限**：RG 只在内存（online_meta 与队列同生命周期），重启后或纯缓存播放拿不到标签 → 按 0 dB 播；根治要把标签随缓存条目落盘。 | F4 的响度字段挂 online_meta 时须同步改 try_relay 的元数据迁移 → 已改：接力时**清掉**旧源的 RG（增益属于那份母带，换源后不适用，等新源取流重填），比留旧值更正确；F5 仅在明确发布面向后启动；无障碍至少补全 Tab 焦点顺序与面板/弹层 Esc 关闭（folia 同样未做，保持最低档） |

## 边界与所有权

- **不动的（评估确认已是干净面）**：token 强度、CSRF 面（无 CORS 层）、cred 钥匙串体系、SQL 参数化、前端 textContent 渲染纪律、WS 鉴权、聚合搜索并发模型、诊断日志轮转、备份导入导出、MediaSession、ScrobbleGate、relay_tried 等既有有界集合。（`/` 的凭据闸门与会话 cookie 是本轮 S2 收紧新增的，见 P2-10；接口层的 Bearer 契约与 token 生成方式未动。）
- 评估报告 `docs/research/hertz-full-assessment.md` 保持工作笔记属性不入库；本 spec 入库。
- 每批次完成后跑全量验证：`cargo test`、`node scripts/check-assets.js`、`node scripts/check-skins.js`、`cargo build --target-dir target-verify`；涉及前端行为的加浏览器验证。
- P0 批次内三项互相独立，可并行实施；P1-1 与 P1-2 涉及同一播放链路的不同端（后端/前端），也可并行。
- 参考仓库 folia-major 只读，不引入其依赖与构建体系；前端继续零依赖 IIFE 约定。

## 验收（批次门）

- **P0**：路径穿越单测五组用例过；扫描批量函数与批边界事务数断言过 + 大库实测提速记录；补全 suggest/apply 双端（HTTP+RPC）演示：候选写库前可见、手动挑选/跳过生效、取消无半写、noAutoMatch 重跑不被覆盖、migration 按项目 up-only 约定只验证增量升级。契约脚本与 cargo test 全绿。
- **P1**：慢源时序测试过 + WebDAV 手动记录；前端 CPU 对比数据；panic 注入测试；面板 pinned/surface 键盘操作演示。全绿同上。
- **P2**：按项独立验收（表内要点即标准），不设批次门。

### 当前证据核对（2026-10-06 按工作树逐条复核，不凭记忆）

**P0**
- 路径穿越：`routes.rs::safe_cover_id` 覆盖 **6 个入口** —— HTTP 的 `get_cover` / `replace_cover` / `batch_delete_tracks`，RPC 的 `library::get_cover` / `replace_cover` / `batch_delete`（`rpc/library.rs` 直接复用 `crate::routes::safe_cover_id`，不是各写一份）。单测 `cover_id_only_accepts_uuids` 钉 7 组负例（`../secret`、`..%2fsecret`、`..\secret`、`..`、`a/b`、空串、带空格）+ 1 组正例，超出 spec 要求的 5 组。
- 扫描批量事务：`scan.rs::SCAN_TX_BATCH = 200`，`report.files.chunks(SCAN_TX_BATCH)` 内 `upsert_tracks_batch` + `set_track_rg_batch` 走同一事务后一次提交；批边界由 `scan_spans_multiple_write_batches` 断言（跑绿）。「大库实测提速记录」在 P2 相关的实测里给过（索引/缓存两项），首扫本身的万首级对比已补档（本轮实测）：10k wav 夹具、同一机器，A=acc8707 中位 56.2 s / B=1b2d72b 中位 17.1 s（提速 3.28×；排程 A,B,B,A 各两轮，A 极差 26.7 s、B 极差 0.5 s），脚本与原始数据在 `output/scan-bench*`。
- 补全两阶段：`POST /v1/tracks/complete/suggest|apply` 双端点 + RPC 对等（`rpc/mod.rs` 两个 arm）→ `complete.rs` 的 `no_auto_match::mark/clear/marked_ids`、migration 0011。spec 里写的「migration 可上可下」按项目 up-only 约定不适用（本文档已注明）。
- 契约与测试：`cargo test --workspace` **379 项全过**；`check-assets` / `check-skins` / `check-css-tokens` / `api-routes --check`（112 条）/ `check-library-api` 全绿。

**P1**
- 锁纪律：`play_local` Remote 分支的建连与 `load_source` 已移出 `play_commit`，时序由 `slow_remote_load_does_not_block_queue_swap` 钉住（跑绿）；`radio_status` 退化为逐字段短锁，且用 `want_tracks` 门控（`radio.active && initial_generation.is_none()` 时才拼曲目，不再「先拼整队再丢弃」），也不再拿 `play_commit`。
- 前端渲染管线：`activeRowMark` 增量 diff（只动新旧两行；未渲染的行由 `updateTrackRow` 按当前快照落位）、`PROGRESS_PAINT_MS = 100` 的进度门控（拖拽/换曲强制不节流）、频谱渐变 `spectrumGradient` 按 key 缓存、`library_changed` → `refreshLibraryInPlace()` 增量合并。
- panic 面：`online/mod.rs::const_url` 覆盖各音源常量站点（`?` 降级为 `ApiError`）；`scan.rs::spawn_guarded` 包住后台扫描任务，`panicking_scan_task_is_recorded_and_releases_the_scanner` 跑绿。
- 命令面板：`palette.js` 的 `PINNED_KEY = 'vmusic.palette.pinned'` + `registerSurface/openSurface` 内联 surface 机制；音量/睡眠两个 surface 的键盘路径在此前会话里做过浏览器实测。

**仍未验证 / 未做（如实列出，不以「应该没问题」替代证据）**

除 F5 外，P0/P1/P2 各项均已收口（详见上文与各表）。
- **【本轮已收口】** P1 的「**长播放会话前端 CPU 对比数据**」：**本轮补了实测，结论与该项的前提相反，如实记录**。方法：A=`acc8707`（优化前）、B=`8e55b03`；同一份夹具（220 首、列表 200 行、null 后端）、同一视口与设置（1440×900 / 经典皮肤），无头 Chrome + CDP `Performance.getMetrics`（TaskDuration / ScriptDuration / LayoutDuration / RecalcStyleDuration）+ rAF 帧计数；两个条件（带 GL 播 3D 舞台 32.3 分钟；`--disable-webgl` 让舞台退化成平面 15 分钟）。三条结论：
  1. **想优化的那一层确实变轻了**：插桩 6 分钟实测 DOM 变更 503/s → 393/s（−22%）、脚本 44.4 → 37.5ms/s（−16%）。
  2. **但总的主线程 CPU 反而更高**：改成**单实例顺序测量**（排除两实例互抢 CPU）后，A 跑两遍 0.536 / 0.540 s/s，B 0.659 s/s —— A 自身重复性 0.7%，**B 比 A 高约 22%**（本轮在同一环境窗口内按 A,B,B,A 各 4 分钟复测，慢窗口 A 0.673/0.665 对 B 0.753/0.755、快窗口 A 0.579 对 B 0.657/0.657，方向与量级一致，**B 高 12–13%**，逐帧 4.56 → 5.88ms）；而脚本 / 布局 / 样式三项 B 都不更高（43.8 vs 51.4/68.4ms/s、146 vs 142/120、15.7 vs 14.8/27.8），多出来的时间按 Trace 落在 `Layerize`（合成器侧图层构建：A 111 → B 211ms/s），**不在本次改动的那条路径上**。
  3. **两实例同时跑的对照组说明该 harness 分辨不了小差异**：同一份二进制、同一批夹具，两侧脚本 67.3 vs 44.3ms/s、样式 24.0 vs 12.3ms/s、帧率 124 vs 137fps —— 噪声底噪与待测效应同量级，所以只有上面第 2 条的单实例顺序结果可用。
  **本轮已查明（2026-10-06 收口，原「待办」）**：① 多的量确在合成器侧，且不是「跑得更勤」而是「每趟更贵」——同一环境窗口内 A/B 的 `Layerize` **次数几乎相同（48.4 vs 48.5 次/s）而每趟耗时翻倍（2.4 → 4.8ms）**，Paint / Layout / FunctionCall 反而是 A 更高（`output/cpu-trace2*.json`）。② 用「只换 `plugin/ui/app.js`、其余全保持 B」的单文件置换二分，整体差异完全由 **`5b5ef46`（P1-2「渲染管线增量更新、命令面板 pinned/surface、弹层焦点与静默 catch 交代」）的 app.js 改动**承载：`app.js@acc8707`（V1）与 `app.js@cc1c154`（P1-2 之前，V2）都回到 A 水平（Layerize 126 / 120ms/s、0.672 / 0.665 s/s），`app.js@5b5ef46`（V3）就是 B 水平（0.746 s/s）；`index.html`（含全部 `defer`）与 `style.css` 的置换都不是来源。③ 与直觉相反，**P1-2 的四个主打优化（频谱渐变缓存、进度/标题节流、active 行增量 diff、播放条动画世代号）没有一个是元凶**：从 B 的 app.js 里逐个撤下，`Layerize` 仍停在 230–240ms/s；把四个合起来放回优化前的 app.js 只有 131ms/s（A 水平）。④ 触发点落在 `5b5ef46` 的 app.js 里**非主打项**的那一坨（`persistSettings` 统一出口、`toggleMute`、两个内联 surface、面板新命令、清风桥接新动作、进度门控）：把整坨单独放回优化前的 app.js 就复现（238ms/s），但**逐个撤下又不消失**（撤 `persistSettings` 275、撤进度门控 231）——即「整坨在场才出现」的涌现效应，**未能定位到单一 hunk**；而这些改动在长播放稳态里全是事件驱动、根本不跑（`registerSurface` 只存不渲染，已用 computedStyle 探针核对页面上没有 `.ps-range`）。⑤ 独立旁证：B 的页面会触发 `stage.js` 的 fps<40 降级（`body.stage-lowfx`），A 从不触发，说明 B 的真实出帧确实更差；但把 `stage-lowfx` 摘掉后做同窗口对照，B 的 `Layerize` 仍翻倍，所以降级是**结果不是原因**。⑥ 合成层候选结构两版完全一致：带 transform/will-change/filter/backdrop-filter/fixed 的元素都是 159 个、CSS 动画都是 665 个（`output/cpu-body-{A,B}.html`、`output/cpu-domprobe*.cjs`）。
  **结论与边界**：这是一条**真实、可复现的回归**，载体已收窄到 `5b5ef46` 的 app.js「非主打项整坨」，代价在合成器侧（`Layerize` 每趟 2×），**不在 P1-2 想优化的 script/layout/style 路径上**（那三项 B 都更低）；因为定位不到单一 hunk，本轮**不做前端修改**（主工作树 app.js 另有 WIP，不动），故不存在「最小修复」。边界：无头软件渲染，绝对值不能外推到真实 GPU 浏览器，`Layerize` 属合成器侧、无头与真机实现路径不同，真实 GPU 上同一改动的影响**未测**。证据：`output/cpu-seq2-{A1,A2,B1,B2}.json`（顺序复现）、`output/cpu-trace2*.json`（Layerize 印证）、`output/cpu-v{1,2,3}-*.json`（整文件置换）、`output/cpu-{r1..r8,s3}-*`（逐块二分）、`output/cpu-body-{A,B}.html`、`output/cpu-inline-{A,B}.json`；脚本 `output/cpu-{instrument,trace2,domprobe,htmldump,layers}.cjs`、`output/cpu-runvariant.ps1`。
- F5 等发布面向。

**WebDAV 场景记录（本轮补上）**：`python scripts/check-library-api.py --remote --binary target-p2/debug/hertz-studio.exe` → `PASS: webdav add/browse/401/import idempotent/direct-link play`（脚本自带 mini DAV 服务器，覆盖远程根的新增/浏览/401 处理/导入幂等/直链播放；与 `slow_remote_load_does_not_block_queue_swap` 那条时序单测互为补充）。

## 实施顺序

P0-1 → P0-2 → P0-3（或并行）→ 全量验证 → P1-1/P1-2（可并行）→ P1-3 → P1-4 → 全量验证 → P2 按需排期。每项一个独立 commit，消息格式沿用 `feat(scope):` / `fix(scope):` 惯例；P0-1 用 `fix(security):`。
