# OpenMusic「平台热榜」调研 + hertz-studio 在线歌曲接入方案

> 源码：`D:\code\github\openmusic`（Node + Express + Socket.IO + Redis；前端 React + Vite）
> 目的：拆解「平台热榜」的实现，给出接入 hertz-studio「在线歌曲」（`crates/vmusicd/src/online/**` + `web/online.js`）的路径。逐文件增量记录（file:line）。

---

## 0. 先分清两个「热榜」

OpenMusic 的 `HotSongPanel` 里有两个数据源，共用一套 UI，**但数据性质完全不同**，别混为一谈：

| 名称 | 数据性质 | 服务端文件 | 接口 |
|---|---|---|---|
| **平台热榜**（本次重点） | **站内自建统计**：本站播放完成次数排行，无上游依赖 | `server/songHotRank.js` | `GET /api/music/hot?limit=` |
| 网易热榜 | 抓网易云排行榜网页 HTML 解析 | `server/neteaseToplist.js` | `GET /api/music/toplist/netease?limit=` |

前端枚举 `HotRankSource = 'netease' | 'platform'`（`client/src/api/music/toplist.ts:4`），`platform` 才是「平台热榜」。

---

## A. 平台热榜 · 数据来源与写入

### A1. 计数入口：只在「用户点播且真正播完」时记

`server/roomManager.js:4863-4869` —— `playNextUnlocked(room, { finishedSong, ... })` 开头：

```js
// 平台热榜：仅统计用户主动点播且真正播放完成的歌曲，随机/漫游（requestedById 为空）不计入
if (finishedSong && finishedSong.requestedById) {
  recordSongPlay(finishedSong);
}
```

判据是 **`requestedById` 非空**。私人漫游 / 收藏随机 / 指定歌单这类系统出曲没有点播人 id
（`roomManager.js:4752` 那段 `requestedBy === '私人漫游' | '收藏随机' | '指定歌单'` 的处理可作对照），
因此被天然排除——**防刷榜的关键就这一行**。

> 注意写入点是「切下一首」而不是「起播」：`playNextUnlocked` 由自然播完（Ended）与手动切歌
> 两条路调用，用 `finishedSong` 是否为 null 区分。

### A2. 写入实现：`server/songHotRank.js`

- `recordSongPlay(song)` (L54-78)：
  - 前置校验 `!song?.id || !song?.name` 直接 return；
  - **无 Redis 时**走 `recordSongPlayMemory`（L31-41，内存 Map 累加 `count`）；
  - 有 Redis 时 `setImmediate(() => { ... })`（L66）**异步 detach，不阻塞主播放流程**；
  - 三步：`zIncrBy(HOT_ZSET_KEY, 1, key)` → `hSet(HOT_META_HASH, key, JSON.stringify(meta))` → `trimHotRank(client)`；
  - `catch` 里回落 `recordSongPlayMemory(song)`（L74）——Redis 挂了榜还在，只是退化成本机内存。
- `songHotKey(source, id)` (L14-16)：`${source || 'netease'}:${id}` —— **复合键，跨音源同名同 id 不会互刷**。
- `buildMeta(song)` (L18-29)：快照 `{ id, source, name, artist, album, pic, duration, lastPlayedAt }`。
  注意：**只存元数据快照，不存播放地址**（与 hertz-studio 的 `play_history` 设计同源）。

### A3. 存储结构与排序

```
ZSET  openmusic:song_hot       member = "<source>:<id>"   score = 播放完成次数
HASH  openmusic:song_hot:meta  member = "<source>:<id>"   value = JSON 快照
```

- `MAX_HOT_ITEMS = 200`（L5）；`trimHotRank` (L43-48)：`zCard > 200` 时
  `zRemRangeByRank(key, 0, size - 200 - 1)` **删掉榜尾最低分段**。
- `getHotSongs(limit = 30)` (L80-121)：
  - `n = clamp(1, limit, 100)`（L81）——上限硬顶 100，默认 30；
  - `zRangeWithScores(key, 0, n-1, { REV: true })`（L86）= 按 score 倒序取 top n；
  - `hmGet` 批量取快照（L90），**按下标对齐** `entries[i]` ↔ `rawMetas[i]`；解析失败/缺 `id|name` 的条目直接丢（L100）；
  - 输出时 `count: Math.round(Number(entry.score) || 0)`（L109）。
- 内存兜底 `getHotSongsFromMemory(n)` (L123-128)：
  `sort((a,b) => b.count - a.count || b.lastPlayedAt - a.lastPlayedAt)` —— **同分用最近播放时间破平**。
- Redis 全挂 → `catch` 回落内存（L114-117）；ZSET 为空也回落内存（L87）。

### A4. HTTP 接口

`server/index.js:1501-1511`：

```js
app.get('/api/music/hot', async (req, res) => {
  if (!requireSessionIdentity(req, res)) return;
  const limit = parseInt(String(req.query.limit || ''), 10);
  const songs = await getHotSongs(Number.isFinite(limit) ? limit : 30);
  res.json(songs);            // 直接是数组，不包 { success, data }
});
```

- 只做 session 鉴权，**没有限流**（对比 `toplist/netease` 有 `limitProxyRequest`，index.js:1538）；
- 响应体是裸数组 `HotSongItem[]`。

### A5. 前端取数与缓存：`client/src/api/music/toplist.ts`

`getPlatformHotSongs(limit = 30)` (L16-39)：
- 双层去重：`platformHotCache: Map<limit, {data, expires}>`（TTL **30s**，L12）+ `platformHotInflight: Map<limit, Promise>`（inflight 合并，L14）；
- `finally` 里 `platformHotInflight.delete(limit)`（L33-35），失败也会被清掉，不会卡死后续请求；
- 请求 `/api/music/hot?limit=${limit}`，错误取 `data.error` 或兜底「获取热榜失败」。

---

## B. 平台热榜 · UI 渲染路径

`client/src/components/HotSongPanel.tsx`（405 行，React，`memo` 包裹）

- **状态模型**：`views: Record<HotRankSource, HotRankView>`（L29-34 / L193-206），
  两个源的 `{ title, songs, loading, error }` 各存一份，**切换源不重新请求**（已加载的视图保住滚动位置）。
- **源选择持久化**：`localStorage['openmusic:hot-rank-source']`（L28 / L36-44 / L213-220），默认 `netease`。
- **加载**：`useEffect([source, neteaseEnabled])` → `load(silent)`（L222-313）
  - platform 分支（L262-295）：调 `getPlatformHotSongs(PLATFORM_LIMIT = 100)`；
    **把 `HotSongItem` 剥掉 `count` 映射成 `SearchResult`**（L271-280，注释明写「不展示 count，只复用热榜行布局」）；
  - **轮询**：`source === 'platform'` 时 `setInterval(..., 30_000)`（L301-307），
    `document.hidden` 时跳过（L304）；`netease` 按日缓存，不轮询。
- **首帧优化**：`peekNeteaseHotToplist(TOPLIST_LIMIT)` 同步读 localStorage（`toplist.ts:107`），
  `useState` 初始化即带数据（L192-199），避免进房转圈。platform 无此优化（默认空 + loading）。
- **渲染**：
  - `renderBody(viewSource)` (L315-367) → `displaySongs = compact ? view.songs.slice(0, compactLimit) : view.songs`；
  - 非 compact：`ToplistRow`（L53-110）竖排，序号 + `SongCover` + 标题/歌手 + 「+」点歌按钮，**双击整行点歌**；
  - compact：`CompactToplistCard`（L112-145）横向 4.25rem 卡片，封面角标；
  - 序号配色 `rankClass(rank)`（L46-51）：1 红 / 2 橙 / 3 琥珀 / 其余 muted + `tabular-nums`；
  - 空态分源文案（L318）：platform 是「暂无平台热榜，播完点歌会出现在这里」——**直接说明了这个榜的数据来源**。
- **挂载点**：`client/src/pages/Room.tsx:3483`（大屏 `embedded`）与 `:3491`（小屏 `compact`），
  `lazyWithRetry` 懒加载（Room.tsx:139/152）；`neteaseEnabled` 由 `sources.some(s => s.id === 'netease')` 决定（Room.tsx:2362）。

---

## C. 对照：网易热榜（上游抓取）要点

`server/neteaseToplist.js`（209 行）——如果 hertz-studio 想做「抓上游榜」，这是现成参照：

- **抓取**：`https://music.163.com/discover/toplist?id=3778678`（L3-4，热歌榜），
  带 `User-Agent` + `Referer: https://music.163.com/`（L10-14），`AbortController` 15s 超时（L34-42）。
- **解析**：优先 `textarea#song-list-pre-data` 里的 JSON（`parseFromTextarea` L87-97），
  失败兜底 `<ul class="f-hide">` 里的 `<a href="/song?id=...">`（`parseFromHiddenList` L99-109，
  兜底分支**拿不到歌手/专辑/封面**）；标题正则 `<h2 class="f-ff2">` 并清洗品牌词（L75-85）。
- **封面参数**：`stripCoverParam`（L44-58）删掉 `?param=NyN`，注释写「避免热榜封面加载失败」。
  ⚠️ 与 hertz-studio `web/online.js:126` 的 `rowCoverUrl` **主动加** `?param=NyN` 策略相反，别混用。
- **缓存三级**：进程内 `memoryCache` → Redis `openmusic:netease:toplist:hot` → 现抓；
  **东八区自然日换桶** `chinaBucketKey = floor((now + 8h) / 24h)`（L21-25），
  TTL = `secondsUntilNextChinaBucket()` 至少 60s（L27-32）；`inflight` 合并并发（L191-202）。
- **接口**：`index.js:1533-1549`，三重闸门 `requireSessionIdentity` → `isMusicSourceEnabled('netease')`
  （`server/musicSources.js:18`）→ `limitProxyRequest` 限流。
- **前端**：`toplist.ts:41-138`，`localStorage['openmusic:netease-hot-toplist:v1']` 同样按东八区日桶缓存，
  模块加载时就 `getFreshCache(200)` 灌进内存（L94-95）。

---

## D. 核心文件清单

| 层 | 文件 | 职责 |
|---|---|---|
| 计数写入 | `server/roomManager.js:4863-4869` | 播完且有点播人 → `recordSongPlay` |
| 统计存储 | `server/songHotRank.js` | ZSET+Hash、内存兜底、topN、截断 |
| HTTP | `server/index.js:1501-1511` | `GET /api/music/hot` |
| 前端取数 | `client/src/api/music/toplist.ts:16-39` | 30s 缓存 + inflight |
| 前端 UI | `client/src/components/HotSongPanel.tsx` | 双源切换、行渲染、30s 轮询 |
| 类型 | `client/src/types.ts:72-76` | `HotSongItem extends Song { count, lastPlayedAt }` |
| 挂载 | `client/src/pages/Room.tsx:3483 / 3491` | embedded / compact |
| （对照）上游榜 | `server/neteaseToplist.js` + `index.js:1533` | 抓 HTML + 按日缓存 |

---

# 第二部分：接入 hertz-studio「在线歌曲」

> 假定「在线歌曲」= hertz-studio 在线曲库模块：
> 后端 `crates/vmusicd/src/online/**`，前端 `crates/vmusicd/web/online.js` + `index.html` 的 `#view-online`。

## E. 现状锚点（hertz-studio 侧）

| 关注点 | 位置 | 说明 |
|---|---|---|
| 归一化契约 | `online/mod.rs:122-141` | `OnlineTrack { source, id, title, artist, album, duration_ms, cover, playable, vip_only, ref }` |
| 音源注册表 | `online/mod.rs:306-406` | `SOURCES`，`caps` 是 UI 唯一事实表 |
| 能力闸门 | `online/mod.rs:785-796` | `gate(source, cap)` → 404 `capability_unsupported` |
| 服务上下文 | `online/mod.rs:434-437` | `Ctx { db: SqlitePool }` |
| 路由段 | `routes.rs:122-157` | `/v1/online/**` 全部注册点 |
| **播放成功唯一收口** | `state.rs:995-1009` `on_track_committed` | 清失败计数 + `record_history` + detach 节拍分析 |
| 写历史 | `state.rs:1040-1083` `record_history` | 在线曲用 `online_meta` 快照；本地曲查库 |
| 自然播完 | `state.rs:1400-1425` | `AudioEvent::Ended` → `step(1, true)` → `post_commit_background` |
| 手动切歌 | `state.rs:1322` `step(delta, auto)` | `auto=false` 表示按按钮 |
| 历史表 | `migrations/0003_playback_state.sql:3-14` | `play_history(track_id UNIQUE, source, ref_id, title, artist, album, cover_url, duration_ms, played_at)` |
| 历史写入/截断 | `history.rs:43-78` | upsert + `DELETE ... NOT IN (SELECT ... ORDER BY played_at DESC LIMIT 500)` |
| 前端行工厂 | `web/online.js:127-206` `buildRow` / `:1043` 导出 `row` | 置灰、VIP、徽标、红心、加歌单 |
| 整盘播放 | `web/online.js:373-450` `playAll` | `POST /v1/online/play`，依赖 `t.ref` |
| 虚拟 id | `web/online.js:97` `virtualId` | `online:<source>:<id>` |
| 视图进入钩子 | `web/app.js:2684` | `setView('online')` → `Online.onViewEnter()` |
| 模块接线 | `web/app.js:4066-4079` | `Online.bind({...})` + `Online.init()` |

## F. 推荐落地路径

### F1. 存储：新增迁移 `migrations/0010_online_hot.sql`

```sql
CREATE TABLE IF NOT EXISTS online_hot (
    track_id       TEXT PRIMARY KEY,   -- online:<source>:<id> 或本地 track id
    source         TEXT NOT NULL,
    ref_id         TEXT NOT NULL,
    title          TEXT NOT NULL,
    artist         TEXT,
    album          TEXT,
    cover_url      TEXT,
    duration_ms    INTEGER,
    track_ref      TEXT,               -- 平台专有引用 JSON（见 F4 的坑）
    play_count     INTEGER NOT NULL DEFAULT 0,
    last_played_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_online_hot_rank ON online_hot(play_count DESC, last_played_at DESC);
```

- ⚠️ `migrations/*.sql` 的**字节会被 sqlx 编译进二进制并在启动比对 sha384**，
  新增/修改后必须 `cargo build`；且已钉 `*.sql text eol=lf`（见 memory/MEMORY.md）。
- 截断上限建议 **500**（对齐 `history.rs:10 HISTORY_LIMIT`）而不是 200：单机没有 Redis 成本压力，
  200 会让冷门歌永远回不来（OpenMusic 的 `trimHotRank` 就是这个副作用）。

### F2. 后端模块 `crates/vmusicd/src/online/hot.rs`

```rust
pub async fn record(pool: &SqlitePool, e: HotEntry<'_>) -> Result<(), String>   // upsert + count+1 + 截断
pub async fn top(pool: &SqlitePool, limit: i64) -> Result<Vec<OnlineTrack>, String>
```

- `top` **直接返回 `OnlineTrack`**（`mod.rs:122`）——这样前端零适配，`playable: true`、
  `vip_only: false`、`ref` 从 `track_ref` 列反序列化；`duration_ms` 来自快照。
- 排序 `ORDER BY play_count DESC, last_played_at DESC LIMIT ?`（与 `getHotSongsFromMemory` L125 同口径），
  `limit.clamp(1, 100)` 默认 30（照抄 `songHotRank.js:81` 的 clamp 语义）。
- 计数用 `SET play_count = play_count + 1`（SQLite 单写者，天然原子），**不要**读-改-写。

### F3. 计数入口：挂到 `Ended` 而不是 `commit`

- **不要**直接复用 `on_track_committed`（`state.rs:995`）——它在**起播成功**时就触发，
  语义是「开始播放」，不是 OpenMusic 的「播完」。起播即计会让「狂点下一首」污染榜。
- 推荐在 `state.rs:1400-1425` 的 `AudioEvent::Ended` 分支里，
  `advance.step(1, true)` **成功之后**记一笔（此时才等价于 OpenMusic 的 `finishedSong`）。
- 「排除随机/漫游」的判据在 hertz-studio **不存在**（没有 `requestedById`、没有房间/点歌人概念）。
  可用替代：`step(delta, auto)` 的 `auto` 参数——`auto=true`（自然播完接力）才计，
  手动切歌（`auto=false`）不计。这与 OpenMusic 「只算真正播完」的口径最接近。
- 是否需要只统计在线曲：若要「在线热榜」语义，`record_history`（`state.rs:1041`）里
  `crate::online::split_virtual_id(track_id)` 命中才写；本地曲分支跳过。

### F4. 路由与配置

- `routes.rs` 在 `/v1/online/sources`（L122）附近加：
  `.route("/v1/online/hot", get(online_hot))`，handler 走 `online_ctx(&state)`（`routes.rs:1991`）。
- hertz-studio **没有 session/多用户**，`requireSessionIdentity` 那层不需要（也不该加）。
- 若做「抓上游榜」（网易云），建议加能力位 `Capability::TopList` 到 `SOURCES[netease].caps`
  （`mod.rs:306`），实现 `netease::toplist()`，dispatch 里过 `gate()` 复用现成闸门——
  前端 UI 由 `/v1/online/sources` 的 `caps` 自动出现入口，无需改 HTML。
- 若做「分平台本机榜」，状态描述沿用 `daily.rs:389-397` 的 `DailyOnlineSkip { kind, message }`
  三态风格（`unavailable` / `unsupported` / `not_signed_in`），别用笼统文案。

### F5. 前端渲染路径（复用优先，新增最少）

1. 新文件 `crates/vmusicd/web/hot.js`，暴露 `window.Hot = { bind, init, onViewEnter, refresh }`；
2. `index.html` 在 `#online-plugins`（约 L438-460，与 `#op-history` 并列）里加
   `<div id="op-hot"><div class="op-section-title">热榜</div><div id="op-hot-list"></div></div>`；
3. `app.js` 在 `window.Online.bind(...)`（L4066）之后 `window.Hot.bind({...})` + `init()`，
   并在 `setView` 的 `name === 'online'` 分支（L2684）里调 `window.Hot.onViewEnter()`；
4. 行渲染：**直接复用 `window.Online.row(track, activate)`**（`online.js:1043` 导出的 `buildRow`），
   `activate` 注入 `window.Online.playAll([track], 0)`。这样置灰/VIP/徽标/红心/加歌单全都不用重写；
5. 取数 `GET /v1/online/hot?limit=30`，前端 30s 内存缓存 + inflight（照抄 `toplist.ts:16-39` 的双 Map）；
6. 序号配色：hertz-studio 没有 Tailwind，需在 `style.css`/`stage.css` 里加 `.hot-rank-1/2/3`；
   ⚠️ `stage.css` 排在 `style.css` 之后，同特异性整块胜出（见 memory/MEMORY.md）——
   热榜样式放 `style.css` 即可，别和 stage 的几何规则撞。

### F6. 数据流转总图

```
[播放完成] audio Ended ─► state.rs:1400 事件泵 ─► step(1, true) ─► 下一首 commit
                              │
                              └─► hot::record(db) ─► online_hot.play_count + 1, last_played_at = now
                                                      (标题/封面/专辑 取自 online_meta 内存快照)

[读榜] 前端 onViewEnter ─► GET /v1/online/hot?limit=30
        └─► routes::online_hot ─► online::hot::top ─► Vec<OnlineTrack> ─► JSON
              └─► web/hot.js ─► window.Online.row(t, () => Online.playAll([t], 0))
                                 └─► 复用徽标/红心/加歌单/置灰 ─► #op-hot-list
```

## G. 两个模块的复用点

| # | 复用点 | 位置 | 怎么用 |
|---|---|---|---|
| 1 | `OnlineTrack` 归一化契约 | `online/mod.rs:122` | 热榜输出直接序列化它，前端零适配 |
| 2 | `buildRow` 行工厂 | `online.js:127` / 导出 `:1043` | 热榜行的置灰/VIP/徽标/收藏/加歌单全部继承 |
| 3 | `badge` / `sourceBadge` / `sourceIcon` | `online.js:69/84/93` | 平台徽标唯一事实源，避免两张表漂移 |
| 4 | `virtualId` + `onlineMeta` | `online.js:97/33` | 播放身份 `online:<source>:<id>` 与快照缓存 |
| 5 | `playAll` + `/v1/online/play` | `online.js:373` | 热榜点播走同一条整盘入队链路 |
| 6 | `Ctx { db }` | `online/mod.rs:435` | 热榜模块与音源模块共用同一个连接池 |
| 7 | `gate()` + `Capability` | `online/mod.rs:785` / `:177` | 能力位驱动 UI，新增榜类能力不改 HTML |
| 8 | 历史表 upsert + 截断写法 | `history.rs:43-78` | 热榜表照抄（含 `DELETE NOT IN` 子查询） |
| 9 | 三态 skip 描述 | `daily.rs:389-397` | 分平台榜的「为什么没有」判别式 |
| 10 | 并发 + 失败隔离 | `aggregate.rs:16-72` | 若抓多平台上游榜，直接复用 `collect` |

## H. 耦合关系与限制（重点）

1. **语义不可照搬**：OpenMusic 是「房间 + 点播人」模型，热榜防刷靠 `requestedById`；
   hertz-studio 是单机播放器，无此概念。用 `step(auto)` 近似，**或明确接受「起播即计」并在 UI 上改名**
   （叫「最近常听」比「热榜」更诚实）。
2. **Redis → SQLite**：ZSET 的 `zIncrBy` + `zRange REV` 换成 `UPDATE ... count+1` + `ORDER BY`。
   单机几百条量级毫无压力；但**不要照抄 `memoryHot` 内存兜底**——hertz-studio 的 SQLite 恒在，
   双写会造出两份互相打架的真相。OpenMusic 那套兜底是为「Redis 可选部署」服务的。
3. **`ref` 缺失是最大的功能坑**：`playAll` 会把 `t.ref` 传给 `/v1/online/play`
   （`online.js:390`），而平台取流依赖它（QQ 的 `media_mid`、酷狗的 `album_id/fileid`，见 `mod.rs:695-697`）。
   热榜若只存快照，`ref` 为空 → 平台模块「仅用 id 尝试」，**可能拿不到最优音质甚至取流失败**。
   对策：`online_hot` 存 `track_ref` 列；或点播前先 `GET /v1/online/detail` 补一次再播。
   这与 `history.rs` 注释「URL 会过期，只存快照」是同一个问题，只是历史页点播可以容忍失败。
4. **快照会过期**：标题/封面/专辑是写入时刻的快照，平台改名改封面后榜上还是旧的。
   接受它（OpenMusic 同样如此），但点击播放前补一次 `detail` 最稳。
5. **合规边界**：`online/mod.rs:17-36` 明列「不做的事」（不解密 DRM、不绕过付费墙、不伪造设备指纹、
   不用他人凭据）。抓上游排行榜 HTML 属公开页面抓取、风险相对低，但**维护成本真实存在**——
   OpenMusic 自己就写了两套解析（textarea + `ul.f-hide` 兜底），说明页面改版会打断。
   建议先做本机统计榜，上游榜作为二期且加 `Capability` 闸门（出问题只摘能力位，不动代码）。
6. **计数时机与污染**：见 F3。若最终选「起播即计」，务必同步 `step(auto=false)` 的手动切歌路径，
   否则点一次「下一首」就多一票。
7. **前端无 TS / 无构建**：`web/**` 是原生 JS，`include_str!` 嵌进二进制——
   **改了 js/css/html 必须 `cargo build`**，重建前要停掉占用 exe 的进程（否则 LNK1104 / os error 5）。
   改完跑一遍 `scripts/check-*.js` 契约脚本（零依赖 Node，替代浏览器测试）。
8. **无 WS 推送**：热榜变更没有推送通道，切回在线视图时刷新即可（仿 `Online.onViewEnter` 的 `loadHistory`），
   不必做 30s 轮询——单机场景下轮询是在给自己找麻烦。
9. **接口形状约定**：OpenMusic 的 `/api/music/hot` 返回裸数组；hertz-studio 其他端点基本是对象。
   建议统一返回 `{ tracks: [...], total, updated_at }`，与 `/v1/online/search` 的 `SearchPage`（`mod.rs:144`）
   保持一致，前端 `renderOnline` 那套 `tracks/total/warning` 处理才能直接搬。
10. **上限口径**：OpenMusic `getHotSongs` clamp 到 100、默认 30；`/v1/online/search` 前端固定 `limit=30`
    （`online.js:253`），聚合 `/search/all` 是 `limit=20`（L286）。热榜建议同样 30，
    并让 `limit` 从查询参数走、服务端 clamp，别在前端写死。
11. **凭据不得出现在榜数据里**：`routes.rs:1364` 已过滤 `online_cookie_*` / `online_cred_*`；
    热榜输出只是曲目快照，天然安全，但 `track_ref` 若含平台敏感字段要自查一遍再落库。
