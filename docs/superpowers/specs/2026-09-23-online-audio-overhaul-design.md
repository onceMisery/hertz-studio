# 在线音源全面优化 设计文档

> 日期：2026-09-23
> 状态：已与用户逐节确认，待最终审阅
> 前置调研：[hertz-online-audit.md](../../research/hertz-online-audit.md)、[mineradio-online.md](../../research/mineradio-online.md)
> 范围：仅在线音源工作线。3D 舞台对标（节拍相机/自由相机/焦点跟拍/玻璃化 UI/存量视觉打磨）为独立的后续 spec，不在此文档实施。

## 1. 背景与问题

当前在线播放链路（审计见调研笔记）存在以下确认过的问题：

1. **整首下载完才能播**：`online::fetch_to_cache`（mod.rs:914-989）把整首响应读进内存再落盘，`play_index_for`（state.rs:140-277）等落盘完成后才 `audio.load()`。冷启动一首几十 MB 的歌要等整首下载。
2. **音质设置不参与取流**：state.rs:199 硬编码 `Some(320_000)`；酷狗通道"先低后高"，登录用户也会拿到匿名 128k（kugou.rs 顺序 return）；缓存名不含音质且永远 `.mp3`，低音质先落盘后永久命中。
3. **失败即终止**：不用 `fallback_urls`、不重试、不降级、不换曲；自动接力失败只 `warn!`，播放静默停止。
4. **运行状态不持久化**：音量/播放模式只在启动时读配置文件（config.rs:63），运行中改动重启丢失；队列/光标纯内存；无播放历史。
5. **资源浪费与阻塞**：跳过的歌仍整首下载完（无 abort）；每次新建 reqwest Client；async 任务内同步 `std::fs` 检查；缓存无容量淘汰。
6. **切歌有爆音/硬切口**：输出链路无增益斜坡。

参考行为（仅行为参考）：Mineradio（GPL-3.0）的边收边播 + 落盘缓存、统一音质枚举、运行期音质上限、统一超时封装。**不得拷贝其代码**，本项目保持 MIT。

## 2. 目标与非目标

### 目标

* 未缓存在线曲目"秒开"：预读阈值后即开始解码播放（边下边播），网络跟得上时播放不中断。

* 音质：跨音源统一四档枚举 + 逐源偏好持久化；修复酷狗通道顺序；缓存按音质与真实容器区分。

* 稳定：分层失败恢复（重试 → fallback/续传 → 自动跳曲）；下载随切歌中止；连接池复用；缓存 LRU。

* 持久化：音量、播放模式重启准确恢复；服务端播放历史（最近 500 条）+ 前端入口。

* 听感：开播/暂停/停止/自然结束的短淡入淡出。

* 前端：缓冲状态可见、错误可操作、档位可切换。

### 非目标（明确不做）

* 播放队列、当前曲目、播放进度的跨重启恢复（用户确认不做；避开在线 URL 过期重建复杂度）。

* 响度归一化 / DSP 音效 / 均衡器。

* 两首交叉淡入淡出（crossfade）。

* 输出设备选择与多设备镜像（Mineradio 有，本项目不涉及）。

* HTTP 直连不落盘的播放模式。

* 3D 舞台相关一切（独立 spec）。

## 3. 硬约束（沿用项目既定契约）

1. 前端零构建：裸 `<script>`、无打包器、无新 npm 依赖；新 vendor 一律不引入。
2. 全页单一 rAF（stage.js），新前端代码只能通过 `Stage.gate()` 挂帧门。
3. 本地优先：音频数据与历史不出本机。
4. 服务端是权威存储：设置/历史入 SQLite，localStorage 不作权威。
5. Rust 侧遵循现有代际提交（`play_generation` + `play_commit`）与 WS 事件协议（`#[serde(tag="type")]`，可选字段缺省缺席）。

## 4. 总体架构

```
play_index_for（state.rs）
  本地曲目 ──► 本地文件路径 ──► audio.load(uri)                     （现有快路径不变）
  在线曲目
    ├─ 音质分键缓存命中（>1KB，旧名单次回退查找）► 本地文件路径快路径
    └─ 未命中：
        1. 读 online_quality 偏好 → online::stream(source,id,quality)
        2. ProgressiveDownload 启动（主 URL + fallback_urls → .part 临时文件）
        3. 等预读阈值，期间 WS 推 Buffering{active:true}
        4. 容器探测决定 progressive / wait-full
        5. audio actor 新命令 LoadSource(Box<dyn MediaSource>, ext_hint)
        6. Play 提交成功 → 写 play_history
        7. 下载完成 → rename 为正式缓存；失败 → 分层恢复
```

### 4.1 新增模块 `crates/vmusicd/src/online/progressive.rs`

职责：渐进下载、同步/异步桥接、预读门、续传、中止、容器探测、落盘。

**核心类型（示意，非最终签名）：**

```rust
pub struct ProgressiveHandle {
    part_path: PathBuf,
    final_path: PathBuf,
    total: Option<u64>,            // Content-Length（chunked 时为 None）
    downloaded: Arc<(Mutex<u64>, Condvar)>,
    abort: Arc<AtomicBool>,
    ext: &'static str,             // 探测出的真实容器扩展名
    mode: PlayModeKind,            // Progressive | WaitFull
    join: JoinHandle<Result<(), DownloadError>>,
}

pub struct HttpMediaSource { /* Read + Seek + Send；读 .part，按 condvar 等待 */ }
```

* 后台 tokio 任务：reqwest 流式 GET（带 `Referer`，沿用 `online::referer`），顺序写 `.part`，每 flush（≥256KB）更新 downloaded 并 notify。

* `HttpMediaSource` 运行在音频 actor 的 OS 线程上（非 async）：

  * `read()`：目标区间超出 downloaded 时在 Condvar 上等待；下载任务报错则返回对应的 `io::Error`（symphonia 解码失败 → actor 发 Error 事件）。

  * `seek()`：支持绝对定位到 `[0, downloaded]`；向前越过 downloaded 时等待追赶（不报错）。

  * `is_seekable() = true`、`byte_len() = total`。

* **预读门**：开播前等待 `downloaded >= min(max(256KB, total*8%), 1.5MB)`；`total=None` 时固定等 256KB。

* **容器探测（moov 问题）**：预读完成后读前缀：

  * mp3（ID3/帧同步）、flac（`fLaC`）、ogg（`OggS`）→ `Progressive`。

  * mp4/m4a（`ftyp`）→ 在已下载前缀（最多前 1MB）扫描 `moov` box：命中 → `Progressive`；未命中 → `WaitFull`（等下载完成再 LoadSource，期间推 `Buffering{active:true,pct:n}`，前端显示"缓冲中 n%"）。

  * 探测不出 → 保守 `WaitFull`。

* **中止**：`ProgressiveHandle` 持 `abort: Arc<AtomicBool>`，与播放代际绑定。代际推进（切歌/换队列/停止）时 set flag 并 abort join handle，删除 `.part`。下载循环每个 chunk 检查 flag。取代"旧代际仍整首下载"的现状。

* **续传与 fallback**：

  * 主连接中途失败：用 `Range: bytes={downloaded}-` 对同一 URL 续一次；再失败对 `fallback_urls` 逐个续传。

  * 起始连接失败：立即换下一个 URL，不写错误缓存。

  * 服务器不支持 Range（200 而非 206）→ 该 URL 从头重下。

* **完成**：flush 后原子 rename（Windows 上沿用现有"终文件存在则复用"防护），notify\_all 解除所有等待。

* `.part` 清理：启动时清空缓存目录内残留 `.part`（上次进程被杀的残骸）。

### 4.2 vmusic-audio 接缝：`LoadSource`

vmusic-audio 当前只有 `Load { uri }`，CpalBackend 只会 `File::open`。新增：

* actor 命令 `LoadSource { source: Box<dyn symphonia_core::io::MediaSource + Send>, ext: Option<String>, track_id, reply }`（经 std mpsc 传递，要求 Send，满足）。

* `AudioBackend` 增加默认方法 `load_source(&mut self, _src, _ext) -> Result<MediaInfo>`，默认返回 `UnsupportedFormat`；NullBackend 不实现（测试不触及）。

* CpalBackend：把现有 `load(path)` 内"File::open + Hint 扩展名 + probe"抽出为 `open_media(source: Box<dyn MediaSource>, ext: Option<&str>)`；`load()` 与 `load_source()` 共用之。

* `AudioHandle::load_source(...)` 异步包装。

* 现有 `load(uri)`、所有调用方、测试不变。

### 4.3 state.rs 播放流程改造

* `play_index_for` 在线分支按第 4 节流程重写；`stream()` 的 quality 参数传入用户档位映射值（见 §5），不再写死 320k。

* 缓存命中检查（exists + metadata）移入 `spawn_blocking`。

* 所有等待点保持/新增 `attempt_alive(gen,index,track_id)` 复核：预读等待后、LoadSource 前、Play 前各一次（与现有三处复核同密度）。

* WaitFull 期间用户可切走：代际复核失败即静默丢弃（现有语义）。

* **下一首预取**：当前曲 Play 提交成功后，用 `step()` 的同一规则 peek 下一个 index（不推进 cursor）；若为在线曲且无缓存，启动一个共享下载器实例写 `.part`（完整下载，不经 MediaSource）。新播放发生/队列变更时代际中止预取。同时只允许 1 个预取任务。`.part` 命名与正式播放一致，正式播放时可直接接管同一文件（检测到已有 `.part` 则附加到现有进度并立即进入边播，不重下）。

* **历史写入**：Play 提交成功且 `attempt_alive` 通过后 upsert play\_history。

  * 在线曲元数据来源：`/v1/online/play` 入队时 tracks 载荷本就带 title/artist/album/duration/cover（routes.rs:1143-1155）。在 AppState 增加 `online_meta: Mutex<HashMap<String /*virtual_id*/, OnlineMetaSnap>>`，online\_play 占队列时把整盘 tracks 的元数据全部写入（同 id 覆盖）；play\_index\_for 提交成功后从该表取快照写历史，取不到则用最小字段（source/id，标题退化为 id）并记 tracing warn。该暂存仅内存、与队列同生命周期（无队列持久化，不存在重启后丢失问题）。

  * 本地曲从 tracks 表读库内字段。

### 4.4 连接池、缓存治理

* `online::client()` 改为 `OnceLock<reqwest::Client>` 进程级共享（超时参数不变：connect 8s / read 12s；下载用独立 builder，read 超时放宽或不设总超时，沿用现有注释里的取舍）。

* 缓存命名：`online:{source}-{id}-{quality}.{ext}`，例如 `qq-a1b2c3-lossless.m4a`；`cache_name` 增加 quality、ext 参数并更新全部调用方。读取时若新名缺失，回退查找一次旧名 `{source}-{id}.mp3`（命中则照播，不重下；下次该曲以新档位播放时自然产生新文件，旧文件交 LRU 淘汰）。

* **LRU**：新增配置 `cache_max_bytes`（默认 2 GiB）。启动后与每次下载完成时，在 `spawn_blocking` 中统计目录总量，超出则按文件 mtime 从旧到新删除，直到低于上限的 90%；白名单：当前播放文件、全部 `.part`。

* 配置项进 config.rs（带默认值，不破坏现有 vmusicd.json）。

### 4.5 WS 缓冲状态

新增事件（独立于音频后端快照，缓冲是下载层状态）：

```json
{"type":"buffering","active":true,"pct":42}
{"type":"buffering","active":false}
```

* `GET /v1/state` 的 JSON 顶层合并同一字段（AppState 内存 overlay，不进 PlayerSnapshot、不改 vmusic-core）。

* 前端：active 时播放按钮区显示缓冲态；有 pct 时显示百分比（WaitFull）；active=false 恢复。

## 5. 音质档位

### 5.1 统一枚举

`standard`（≈120k）/ `exhigh`（≈320k）/ `lossless`（FLAC）/ `hires`（Hi-RES）。在 vmusicd 定义枚举 +  serde 表示 + rank 序 + 别名归一化（`320k→exhigh`、`flac/sq→lossless` 等），单测覆盖。

逐源默认与可请求映射：

| 音源       | 默认       | 可请求                      | 说明                       |
| -------- | -------- | ------------------------ | ------------------------ |
| netease  | hires    | 全部                       | br 透传，沿用现状               |
| qq       | lossless | 全部（不含 jymaster 类）        | 现有候选切片/探活保留              |
| kugou    | lossless | standard/exhigh/lossless | 修复通道顺序                   |
| qishui   | standard | 由非加密档实际决定                | 加密档报 vip\_required 的语义保留 |
| ccmixter | standard | 忽略档位                     | 直链                       |

### 5.2 偏好持久化

* settings 键 `online_quality`：JSON `{"netease":"hires","qq":"lossless","kugou":"lossless","qishui":"standard"}`；逐字段归一化、坏值回默认。

* API：`GET /v1/online/quality` 返回当前 map；`POST /v1/online/quality {source,quality}` 校验后即时落库。

* 前端：音源工具区（`#online-source` 附近）放档位选择器，随当前音源切换；改动即保存。**正在播当前音源的在线曲目时切换档位 = 热切换**：保存偏好后对当前曲立即重新走取流+播放流程（新档位新缓存键，旧下载/旧 `.part` 按代际中止），并接续当前播放进度；切换期间走 buffering 态。本地曲目与其他音源曲目不受影响（下首自然生效）。

### 5.3 音源修复

* **kugou**：通道排序改为：登录态且请求 ≥320k → 登录网关 `/v5/url`（quality\_param 沿用现有映射）；失败 → Web H5 + retry 域；最后 → 移动匿名 128k。`bitrate/fallback_urls` 尽量回填而非 None/空。

* 实际码率低于请求档（版权/SVIP）时：播放侧不报错。`/v1/online/play` 的 JSON 响应携带当前曲的 `actual_quality`，前端给该曲目行打"实际 320k"小标，本会话首次降级时 toast 一次；自动接力路径不打扰（不为此加 WS 事件）。该 cap 仅内存（URL 可用性随登录态变化，不持久化）。

## 6. 失败恢复策略

| 阶段                               | 策略                                                     |
| -------------------------------- | ------------------------------------------------------ |
| 取流 API 超时/5xx                    | 同音源重试 1 次                                              |
| 下载起始连接失败                         | 换 fallback\_urls，全失败才判失败                               |
| 下载中途断流                           | 同 URL Range 续一次 → fallback\_urls 各续一次；均不支持 Range 则重头一次 |
| `auth_required` / `vip_required` | 不重试，直接判不可用                                             |
| 解码失败（文件其实是错误页等）                  | 删除该 `.part`/坏缓存，按下载失败路径走一次                             |

失败收口（改造 `online_play_failed`）：

* **自动接力触发的播放**：自动 `step()` 到下一首并 WS 推 toast 类错误（`code` 沿用现有、`message` 形如"《xx》暂不可用，已跳过"）；连续自动失败计数达 3 → 停止并推终态错误（带动作建议：去登录/换音源）。任何一首成功播放即清零计数。

* **用户手动点播失败**：保持当前曲不跳走，推错误事件，前端错误条提供"重试 / 下一首"。

* 已被代际顶掉的失败：静默丢弃（现有语义不变）。

* 只有真正 Play 成功才写历史。

## 7. 状态持久化与播放历史

### 7.1 settings（现有表，新键）

| 键                | 值                                      | 写入时机                        |
| ---------------- | -------------------------------------- | --------------------------- |
| `player_volume`  | JSON 数字 0.0–1.0                        | `/v1/player/volume` 每次调用即时写 |
| `player_mode`    | JSON `"repeat"/"repeat_one"/"shuffle"` | `/v1/player/mode` 即时写       |
| `online_quality` | JSON map                               | 档位切换时                       |

启动顺序（main.rs）：DB 可用 → 读 settings → 应用到 audio actor（set\_volume/set\_mode），缺键回退 config 文件值与默认值；DB 不可用时维持现状（config 默认）。写 settings 失败不阻断播放命令（tracing 记录，前端仍以快照为准）。

### 7.2 migration `migrations/0003_playback_state.sql`

```sql
CREATE TABLE IF NOT EXISTS play_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id    TEXT NOT NULL UNIQUE,   -- 本地 id 或 online:{source}:{ref_id}
    source      TEXT NOT NULL,          -- 'local' / 'netease' / 'qq' / ...
    ref_id      TEXT NOT NULL,          -- 音源内 id（本地即 track id）
    title       TEXT NOT NULL,
    artist      TEXT,
    album       TEXT,
    cover_url   TEXT,                   -- 在线封面快照 URL；本地可为空
    duration_ms INTEGER,
    played_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_play_history_played ON play_history(played_at DESC);
```

* upsert：`track_id` 冲突时更新全部元数据字段与 `played_at`（重播置顶）。

* 截断：每次 upsert 后删除按 `played_at` 排序超出 500 条之外的行（单条 DELETE，廉价）。

### 7.3 API 与前端入口

* `GET /v1/history?limit=50`（默认 50，上限 100）：按 played\_at 倒序。

* `DELETE /v1/history`：清空。

* `DELETE /v1/history/:id`：单条删除（id 为历史行 id）。

* 点击行：在线曲走现有在线播放入口（虚拟 id 入队），本地曲走本地播放。

* **前端入口（用户已选方案 B）**：在线曲库面板个人区（`#online-plugins` 内，"我的账号"之前）新增"最近播放"区块：列表行（封面/标题/艺术家/相对时间）+ "清空"；单条删除走行上悬停按钮。样式复用 `online.css` 既有令牌，不引入新视觉体系。

* 在线曲与本地曲都记录；行上标明来源（本地/音源名）。

## 8. 淡入淡出（cpal 后端 DSP）

在 cpal 输出样本循环对交错样本乘增益系数（f32，逐样本线性斜坡；样本级斜坡在 44.1kHz 下无可闻拉链噪声）：

| 事件                    | 斜坡                                                                  |
| --------------------- | ------------------------------------------------------------------- |
| Play（含切歌后新曲开播）        | 0 → 1，250ms                                                         |
| Pause                 | 1 → 0，200ms，斜坡完成后再暂停设备写入（避免淡出被截断）                                   |
| Stop                  | 1 → 0，200ms                                                         |
| 手动切歌（Load/LoadSource） | 旧源先 1 → 0 淡出 200ms，再换装并淡入                                           |
| 自然结束                  | 结束前 500ms 开始 1 → 0（按 position/duration 计算；duration 未知时不淡出，依赖曲目自身收尾） |

* **手动切歌的时序（不阻塞 actor）**：Load/LoadSource 到达后端时，若正在播放，后端把新源存入 pending 槽并武装 200ms 淡出；输出线程在增益到 0 的那一刻换装解码器、武装淡入并按"换装前是否在播放"决定是否起播（其间到达的 Play 命令写"换装后播放"标志位）。`apply` 不阻塞，快照/频谱照常每 20ms 发布。这是增益包络首尾相接，不是两首混合（非 crossfade）。代价是手动切歌到新源出声多约 200ms（淡出段），在可接受范围；自动接力同理，Ended 前的尾部淡出已覆盖大部分接缝。

* 频谱/能量分析的采样点取**淡变前**信号：舞台可视化不随淡出塌陷。

* 淡变时长为常量（不做用户设置，YAGNI）；null backend 不实现。

* Seek 不触发淡变。

## 9. 前端改动清单（零新增依赖）

| 文件                                        | 改动                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| online.js                                 | 档位选择器与 `/v1/online/quality` 对接；buffering 事件与缓冲 UI；错误条（重试/下一首）；实际档位小标；WaitFull 百分比 |
| online-playlists.js 或新小段（挂在 online 初始化链上） | "最近播放"区块渲染/清空/单删/点击播放；优先并入现有个人区渲染文件，避免新文件                                         |
| online.css                                | 历史区块、档位选择器、缓冲/错误态样式（复用既有令牌）                                                       |
| app.js                                    | 音量/模式启动对齐以服务端快照为准（现有快照通道已在，核对无本地覆盖写回）；WS `buffering` 事件分支                         |
| index.html                                | 个人区"最近播放"容器、音源工具区档位选择器容器                                                          |
| （无新 rAF、无新 vendor）                        | —                                                                                 |

## 10. 错误与边界清单

* `.part` 残留：启动清；进程崩溃后不占 LRU 白名单之外的空间。

* chunked 无 Content-Length：预读固定 256KB；byte\_len=None；WaitFull 判定仅依赖 moov 扫描结果（无总长时 m4a 未找到 moov 即 WaitFull，等待结束以连接 EOF 为准）。

* 磁盘写满：下载任务报错 → 按失败策略；提示用户缓存可能满（LRU 也会自动腾挪）。

* 用户 seek 超出已下载：解码线程在 MediaSource 内阻塞等待，不额外发请求（若整曲时长很长，等待受网络吞吐约束；WaitFull 曲目不允许越过文件的 seek 自然成立）。

* 预取与正式播放抢同一 `.part`：以 AppState 内的 `Map<cache_key, ProgressiveHandle>` 注册表串行——缓存键（含音质）一致时正式播放接管预取句柄，不另开下载；音质偏好已变、键不一致时不接管，中止旧预取并按新键开下载。

* 同一缓存文件旧版无扩展名回退命中后播放失败：删除旧文件并按新流程重取一次。

* 历史中的在线曲目再次播放时 URL 已过期：历史只存元数据，播放走实时取流，天然不过期。

* settings 写入与读取的 JSON 全部 try/归一化，坏值回默认且不 panic。

## 11. 测试与验证

### Rust 单测/集成

* 音质枚举：别名归一化、rank、逐源默认、坏值回退。

* kugou 通道顺序回归（mock 网关：登录高码率优先）。

* cache\_name：含 quality/ext；旧名回退查找。

* play\_history：upsert 置顶、字段更新、500 截断、API（含 404/limit 钳制）。

* settings：volume/mode 写入后模拟重启读取恢复；缺键回退。

* progressive：慢源 mock（可控节拍的 chunk channel）验证——预读门阻塞/放行、seek 等待、abort 及时终止且删 `.part`、Range 续传、fallback 顺序、WaitFull/Progressive 判定（构造 mp3/flac/early-moov/late-moov 字节前缀）。

* 淡变：增益斜坡数值断言（起点 0、终点 1、斜率、暂停时先完成斜坡）。

* 自动跳曲：连续 3 首失败停止、成功清零、手动失败不跳。

* 现有 qq.rs 数组对齐等回归测试保持通过。

### 无头契约检查（scripts/）

* 扩展 check-online.js：新端点引用、档位选择器/历史区块 DOM 契约、`buffering` 事件分支存在。

* 新增 check-progressive.js：钉模块边界（在线源只能经 LoadSource 进 actor；play\_index\_for 不再出现硬编码 320\_000；`.part` 命名与清理调用点）。

* 全部现有 check-\*.js 通过。

### 真机烟测（Windows，实跑服务）

1. 冷启未缓存曲目：观察秒开（mp3/flac 与 m4a 各一首）。
2. 开发者工具限速弱网：验证续传、缓冲态、播放不中断/超时跳曲。
3. 连续点下一首：旧下载中止（`.part` 删除、无残留流量）。
4. 酷狗登录账号切到 lossless：确认拿到高码率（实际档位标）。
5. 重启服务：音量、播放模式保持；历史在、可点击重播。
6. 自然结束/手动切歌/暂停：听感无爆音；淡出时舞台粒子不塌陷。
7. 缓存灌超 2GB：LRU 淘汰生效且当前曲不受影响。

## 12. 实施顺序（供 writing-plans 细化，非承诺粒度）

1. migration + settings 持久化（音量/模式）+ 启动恢复。
2. 音质枚举/偏好/API + kugou 通道修复 + 缓存命名改造。
3. progressive 下载器 + LoadSource 接缝 + state.rs 流程重写 + buffering 事件。
4. fallback/续传/失败收口/自动跳曲 + 预取 + 共享 client + LRU。
5. cpal 淡入淡出。
6. play\_history 表/API/前端区块。
7. 前端档位选择器、缓冲与错误态、实际档位标。
8. 契约检查、单测、真机烟测。

## 13. 主要变更文件一览

* 新增：`migrations/0003_playback_state.sql`、`crates/vmusicd/src/online/progressive.rs`、`crates/vmusicd/src/history.rs`（放在 vmusicd，与 daily.rs/online 同级：它面向服务端 HTTP/WS 场景且复用 AppState 的连接池；不放 vmusic-store，避免给 store crate 引入在线音源概念）、`scripts/check-progressive.js`。

* Rust：`vmusic-audio/src/{actor.rs,cpal_backend.rs,lib.rs}`、`vmusic-core/src/{audio.rs,model.rs}`（trait 默认方法/枚举如需要）、`vmusicd/src/{state.rs,routes.rs,main.rs,config.rs}`、`online/{mod.rs,kugou.rs,qq.rs,netease.rs,qishui.rs}`。

* 前端：`web/{index.html,app.js,online.js,online-playlists.js,online.css}`。

